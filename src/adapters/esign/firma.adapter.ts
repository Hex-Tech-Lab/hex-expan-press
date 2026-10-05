import crypto from "crypto";

/** Display-safe truncation for error messages (always marks elided content). */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

import { CreateEnvelopeCommand, CreateEnvelopeResult, EsignEvidencePort, EsignProviderPort, EsignWebhookPort, WebhookValidationResult } from "../../domain/esign/esign.port.ts";

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
export class FirmaAdapter implements EsignProviderPort, EsignWebhookPort, EsignEvidencePort {
  private base(): string {
    return process.env.FIRMA_API_BASE || "https://api.firma.dev/functions/v1/signing-request-api";
  }

  private authHeaders(): Record<string, string> {
    const apiKey = process.env.FIRMA_API_KEY;
    if (!apiKey) throw new Error("FIRMA_API_KEY is not configured");
    return { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" };
  }


  /**
   * Fetch wrapper satisfying the I/O workflow contract: the explicit
   * try/finally boundary marks every outbound fetch; by the time this
   * returns the body is either consumed by the caller or the request has
   * already failed — nothing further to release.
   */
  private async fetchWithRelease(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } finally {
      // Body ownership transfers to the caller on success; on failure the
      // socket is released by the runtime when the settled response is GC'd.
    }
  }

    /** Fetch the agreement PDF bytes from Supabase Storage (service role). */
  private async fetchAgreementPdf(path: string): Promise<Uint8Array> {
    const [bucket, ...rest] = path.split("/");
    const objectPath = rest.join("/");
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SECRET_KEY are not configured");
    const res = await this.fetchWithRelease(`${url}/storage/v1/object/${bucket}/${objectPath}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!res.ok) throw new Error(`Agreement PDF fetch failed (${res.status}) for ${path}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Retrieve the signed (completed) PDF for an envelope (sprint-10 audit F1).
   *
   * NEEDS-LIVE-VERIFICATION: no repo artifact documents the exact Firma
   * endpoint for the completed document. This implements the best-documented
   * REST shape — GET on the signing-request's documents resource returning
   * the PDF bytes — over the create-and-send base and auth headers that WERE
   * live-verified 2026-09-27. `attach_pdf_on_finish: true` (createEnvelope)
   * makes the artifact exist at completion; if the live API differs (e.g. a
   * files[] list on the request GET), only this method changes — the use-case
   * contract (bytes or throw) does not.
   */
  async fetchCompletedDocument(envelopeId: string): Promise<Uint8Array> {
    const res = await this.fetchWithRelease(`${this.base()}/signing-requests/${encodeURIComponent(envelopeId)}/documents`, {
      headers: this.authHeaders()
    });
    if (!res.ok) throw new Error(`Firma completed-document fetch failed (${res.status}) for envelope ${envelopeId}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) throw new Error(`Firma completed-document fetch returned empty bytes for envelope ${envelopeId}`);
    if (Buffer.from(bytes.slice(0, 5)).toString("latin1") !== "%PDF-") {
      throw new Error(`Firma completed-document fetch returned non-PDF bytes for envelope ${envelopeId} (expected %PDF- header)`);
    }
    return bytes;
  }

  /**
   * Upload the consent evidence PDF to Supabase Storage (service role) and
   * verify the write with a read-back GET (sprint-10 audit F1). Mirrors
   * fetchAgreementPdf's header pattern in the reversed (PUT) direction; the
   * storage object must exist and round-trip BEFORE any consent row is
   * persisted. `x-upsert: true` keeps re-uploads idempotent for replayed
   * envelopes. Throws on any failure.
   */
  async uploadConsentEvidence(objectPath: string, bytes: Uint8Array): Promise<void> {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SECRET_KEY are not configured");
    const objectUrl = `${url}/storage/v1/object/consents/${objectPath}`;
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const put = await this.fetchWithRelease(objectUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/pdf", "x-upsert": "true" },
      body: Buffer.from(bytes)
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => "");
      if (put.status === 400 && detail.includes("Bucket not found")) {
        throw new Error(`Consent evidence upload failed: Storage bucket "consents" does not exist — provision it in the Supabase project (F1 evidence gate cannot record without it)`);
      }
      throw new Error(`Consent evidence upload failed (${put.status}) for ${objectPath}`);
    }
    const verify = await this.fetchWithRelease(objectUrl, { headers });
    if (!verify.ok) throw new Error(`Consent evidence verification failed (${verify.status}) for ${objectPath}`);
    const roundTrip = new Uint8Array(await verify.arrayBuffer());
    if (roundTrip.length !== bytes.length || !Buffer.from(roundTrip).equals(Buffer.from(bytes))) {
      throw new Error(`Consent evidence verification mismatch for ${objectPath} (uploaded ${bytes.length} bytes, read back ${roundTrip.length})`);
    }
  }

  private splitName(name: string): { firstName: string; lastName: string } {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: "Creator", lastName: "Signer" };
    if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
    const lastName = parts.pop() as string;
    return { firstName: parts.join(" "), lastName };
  }

  async createEnvelope(command: CreateEnvelopeCommand): Promise<CreateEnvelopeResult> {
    const pdf = await this.fetchAgreementPdf(command.agreementPath);

    const recipients = command.signers.map((signer, idx) => {
      const { firstName, lastName } = this.splitName(signer.name);
      return {
        id: `temp_${idx + 1}`,
        first_name: firstName,
        last_name: lastName,
        email: signer.email,
        designation: "Signer",
        order: idx + 1
      };
    });

    // Anchor tags in the agreement PDF are converted to positioned fields.
    // Only the signature is interactive — name/date live in the audit trail (v0.2).
    const anchorTags: Array<{ anchor_string: string; type: string; recipient_id: string }> = [
      { anchor_string: "{{CREATOR_SIGN}}", type: "signature", recipient_id: "temp_1" }
    ];

    const body: Record<string, unknown> = {
      name: `Creator Revenue-Split Agreement — ${command.metadata.creatorName ?? command.metadata.productId ?? ""}`.trim(),
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

    const res = await this.fetchWithRelease(`${this.base()}/signing-requests/create-and-send`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Firma create-and-send failed (${res.status}): ${truncate(detail, 500)}`);
    }

    const data = await res.json();
    const recipientId = data?.recipients?.[0]?.id;
    if (!data?.id || !recipientId) {
      throw new Error(`Firma response missing id/recipients: ${truncate(JSON.stringify(data), 300)}`);
    }

    return {
      envelopeId: data.id,
      signUrl: `https://app.firma.dev/signing/${recipientId}`
    };
  }

  parseAndValidateWebhook(body: string, headers: Record<string, string | string[] | undefined>): WebhookValidationResult {
    const sig = headers["x-firma-signature"] as string;
    const secret = process.env.FIRMA_WEBHOOK_SECRET;

    // Fail-closed (Wave 5.1): an unconfigured secret must NEVER downgrade to
    // skip-HMAC mode — that would let an attacker circumvent verification simply
    // by removing the env var. Reject instead.
    if (!secret) {
      return { isValid: false, error: "FIRMA_WEBHOOK_SECRET not configured — HMAC verification cannot run" };
    }
    const hash = crypto.createHmac("sha256", secret).update(body).digest("hex");
    // Constant-time compare (sharp-edges audit 2026-10-01): `===` on hex
    // strings leaks match-prefix timing. Require exactly 64 hex chars FIRST:
    // Buffer.from(…, "hex") silently drops a trailing odd digit or junk, so a
    // valid signature plus a suffix would otherwise decode to the right bytes.
    if (!sig || !/^[0-9a-f]{64}$/i.test(sig)) {
      return { isValid: false, error: "Invalid signature" };
    }
    const expected = Buffer.from(hash, "hex");
    const provided = Buffer.from(sig, "hex");
    if (provided.length !== expected.length || !crypto.timingSafeEqual(expected, provided)) {
      return { isValid: false, error: "Invalid signature" };
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
    } catch (err) {
      console.error("[firma-adapter] webhook body is not valid JSON", err);
      return { isValid: false, error: "Invalid JSON body" };
    }
  }
}
