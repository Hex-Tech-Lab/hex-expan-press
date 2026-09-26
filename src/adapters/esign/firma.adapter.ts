import { CreateEnvelopeCommand, CreateEnvelopeResult, EsignProviderPort, EsignWebhookPort, WebhookValidationResult } from "../../domain/esign/esign.port.ts";
import crypto from "crypto";

/**
 * Firma.dev adapter (verified against the live API 2026-09-27).
 *
 * Real API base: https://api.firma.dev/functions/v1/signing-request-api
 * (NOT /v1 — the old base 404'd on every path, which the previous mock
 * fallback silently converted into a fake signing URL. Fails loud now.)
 *
 * Flow used: signing-requests/create-and-send (atomic) with the agreement
 * PDF + anchor tags ({{CREATOR_SIGN}} etc. are auto-located and converted
 * into positioned fields), then the embedded signing URL is
 * https://app.firma.dev/signing/<recipient_id>.
 */
export class FirmaAdapter implements EsignProviderPort, EsignWebhookPort {
  private base(): string {
    return process.env.FIRMA_API_BASE || "https://api.firma.dev/functions/v1/signing-request-api";
  }

  private authHeaders(): Record<string, string> {
    const apiKey = process.env.FIRMA_API_KEY;
    if (!apiKey) throw new Error("FIRMA_API_KEY is not configured");
    return { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" };
  }

  /** Fetch the agreement PDF bytes from Supabase Storage (service role). */
  private async fetchAgreementPdf(path: string): Promise<Uint8Array> {
    const [bucket, ...rest] = path.split("/");
    const objectPath = rest.join("/");
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SECRET_KEY are not configured");
    const res = await fetch(`${url}/storage/v1/object/${bucket}/${objectPath}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!res.ok) throw new Error(`Agreement PDF fetch failed (${res.status}) for ${path}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private splitName(name: string): { firstName: string; lastName: string } {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: "Creator", lastName: "Signer" };
    if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
    return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
  }

  async createEnvelope(command: CreateEnvelopeCommand): Promise<CreateEnvelopeResult> {
    const pdf = await this.fetchAgreementPdf(command.agreementPath);

    const recipients = command.signers.map((s, idx) => {
      const { firstName, lastName } = this.splitName(s.name);
      return {
        id: `temp_${idx + 1}`,
        first_name: firstName,
        last_name: lastName,
        email: s.email,
        designation: "Signer",
        order: idx + 1
      };
    });

    // Anchor tags in the agreement PDF are converted to positioned fields.
    const anchorTags: Array<{ anchor_string: string; type: string; recipient_id: string }> = [
      { anchor_string: "{{CREATOR_SIGN}}", type: "signature", recipient_id: "temp_1" },
      { anchor_string: "{{CREATOR_NAME}}", type: "text", recipient_id: "temp_1" },
      { anchor_string: "{{CREATOR_DATE}}", type: "date", recipient_id: "temp_1" }
    ];

    const body: Record<string, unknown> = {
      name: `Creator Revenue-Split Agreement — ${command.metadata.productId ?? ""}`.trim(),
      document: Buffer.from(pdf).toString("base64"),
      expiration_hours: 168,
      recipients,
      anchor_tags: anchorTags,
      settings: {
        use_signing_order: true,
        send_signing_email: true,
        attach_pdf_on_finish: true,
        allow_download: true
      }
    };
    if (command.redirectUrl) body.redirect_url = command.redirectUrl;
    if (command.webhookUrl) body.webhook_url = command.webhookUrl;
    if (Object.keys(command.metadata ?? {}).length) body.metadata = command.metadata;

    const res = await fetch(`${this.base()}/signing-requests/create-and-send`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Firma create-and-send failed (${res.status}): ${detail.slice(0, 500)}`);
    }

    const data = await res.json();
    const recipientId = data?.recipients?.[0]?.id;
    if (!data?.id || !recipientId) {
      throw new Error(`Firma response missing id/recipients: ${JSON.stringify(data).slice(0, 300)}`);
    }

    return {
      envelopeId: data.id,
      signUrl: `https://app.firma.dev/signing/${recipientId}`
    };
  }

  parseAndValidateWebhook(body: string, headers: Record<string, string | string[] | undefined>): WebhookValidationResult {
    const sig = headers["x-firma-signature"] as string;
    const secret = process.env.FIRMA_WEBHOOK_SECRET || "";

    if (secret) {
      const hash = crypto.createHmac("sha256", secret).update(body).digest("hex");
      if (sig !== hash) {
        return { isValid: false, error: "Invalid signature" };
      }
    }

    try {
      const payload = JSON.parse(body);
      const type = payload.type || payload.event || "";
      if (type !== "signing_request.completed") {
        return { providerName: "firma", isValid: true, event: { eventType: "unknown", envelopeId: payload?.data?.signing_request?.id || "unknown", metadata: payload?.data?.signing_request?.metadata || {}, documentHash: "" } };
      }
      return {
        providerName: "firma",
        isValid: true,
        event: {
          eventType: "envelope.completed",
          envelopeId: payload?.data?.signing_request?.id || "unknown",
          metadata: payload?.data?.signing_request?.metadata || {},
          documentHash: payload?.data?.signing_request?.document_sha256 || ""
        }
      };
    } catch {
      return { isValid: false, error: "Invalid JSON body" };
    }
  }
}
