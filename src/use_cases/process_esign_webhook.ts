import { SettingsRegistryPort } from "../domain/settings/settings.port.ts";
import { createEsignAdapter } from "../adapters/esign/esign.factory.ts";
import { ConsentDatabasePort } from "../domain/governance/consent.port.ts";

export interface ProcessEsignWebhookRequest {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
  userAgent: string;
}

export async function processEsignWebhookUseCase(
  req: ProcessEsignWebhookRequest,
  settingsRegistry: SettingsRegistryPort,
  database: ConsentDatabasePort
): Promise<void> {
  const settings = await settingsRegistry.getPortalSettings();
  const esignAdapter = createEsignAdapter(settings.esign);

  // 1. Validate and Parse Webhook (Provider-agnostic)
  const validation = esignAdapter.parseAndValidateWebhook(req.body, req.headers);
  if (!validation.isValid || !validation.event) {
    throw new Error(`Webhook validation failed: ${validation.error}`);
  }

  const { event } = validation;

  // 2. Map domain event to governance actions
  if (event.eventType === "envelope.completed") {
    // Metadata integrity gate (Wave 5.1, hardened): metadata must BE an
    // object with non-empty string productId/userId BEFORE destructuring —
    // a completed envelope without that linkage can never be attributed to
    // a consent record, so reject (400 via the webhook's validation-failed
    // contract) instead of writing a partial/garbage consent row.
    const metadata = event.metadata as unknown;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error(`Webhook validation failed: completed envelope ${event.envelopeId} has no metadata object`);
    }
    const { productId, userId } = metadata as Record<string, unknown>;
    if (typeof productId !== "string" || productId.trim() === "" || typeof userId !== "string" || userId.trim() === "") {
      throw new Error(`Webhook validation failed: completed envelope ${event.envelopeId} is missing productId/userId metadata`);
    }
    const envelopeId = event.envelopeId;

    // The PDF path is abstracted here, but typically bounded to user and envelope
    const pdfPath = `${userId}/${envelopeId}.pdf`;

    // 3. Persist the legal consent (C3) using the Database Port
    try {
      await database.submitConsent({
        productId: productId,
        userId: userId, // Used to construct path or extra validation if needed by adapter
        kind: "C3_revenue_split",
        decision: "given",
        textVersion: "v1.0", // Can be dynamic based on settings in future
        documentSha256: event.documentHash,
        typedName: `Signed via ${validation.providerName || "unknown"}`,
        ip: req.ip,
        userAgent: req.userAgent,
        authProvider: validation.providerName || "unknown",
        externalRef: envelopeId,
        evidencePath: pdfPath
      });
    } catch (err) {
      // Replay of an already-recorded envelope: the unique (kind, external_ref)
      // index rejects the second row (audit F5). Acknowledge so the provider
      // stops retrying; anything else still fails.
      if ((err as { code?: unknown })?.code === "23505") return;
      throw err;
    }
  }
}
