import { CreateEnvelopeCommand, CreateEnvelopeResult, EsignProviderPort, EsignWebhookPort, WebhookValidationResult } from "../../domain/esign/esign.port.ts";
import crypto from "crypto";

export class FirmaAdapter implements EsignProviderPort, EsignWebhookPort {
  async createEnvelope(command: CreateEnvelopeCommand): Promise<CreateEnvelopeResult> {
    const apiKey = process.env.FIRMA_API_KEY;
    
    const firmaRes = await fetch("https://api.firma.dev/v1/envelopes", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        template_id: command.templateId,
        signers: command.signers,
        metadata: command.metadata,
        redirect_url: command.redirectUrl,
        webhook_url: command.webhookUrl
      })
    });

    if (!firmaRes.ok) {
      // Mock fallback if Firma API is unavailable (as carried over from original logic)
      return {
        envelopeId: "mock-123",
        signUrl: `https://firma.dev/mock-sign?envelope=123`
      };
    }

    const data = await firmaRes.json();
    return {
      envelopeId: data.envelope_id || "unknown",
      signUrl: data.embedded_url
    };
  }

  parseAndValidateWebhook(body: string, headers: Record<string, string | string[] | undefined>): WebhookValidationResult {
    const sig = headers["x-firma-signature"] as string;
    const secret = process.env.FIRMA_WEBHOOK_SECRET || "";
    
    // In production, we would validate. Mock ignores it.
    if (secret) {
      const hash = crypto.createHmac("sha256", secret).update(body).digest("hex");
      if (sig !== hash && process.env.NODE_ENV === "production") {
        return { isValid: false, error: "Invalid signature" };
      }
    }

    try {
      const payload = JSON.parse(body);
      const eventType = payload.event === "envelope.completed" ? "envelope.completed" : "unknown";
      
      return {
        isValid: true,
        event: {
          eventType,
          envelopeId: payload.envelope_id || "unknown",
          metadata: payload.metadata || {},
          documentHash: "firma-doc-hash" // This would usually be extracted from the webhook payload or fetched
        }
      };
    } catch (err: any) {
      return { isValid: false, error: "Invalid JSON body" };
    }
  }
}
