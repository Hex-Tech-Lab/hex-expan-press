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
    const { productId, userId } = event.metadata;
    const envelopeId = event.envelopeId;

    // The PDF path is abstracted here, but typically bounded to user and envelope
    const pdfPath = `${userId}/${envelopeId}.pdf`;

    // 3. Persist the legal consent (C3) using the Database Port
    await database.submitConsent({
      productId: productId,
      userId: userId, // Used to construct path or extra validation if needed by adapter
      kind: "C3_revenue_split",
      decision: "given",
      textVersion: "v1.0", // Can be dynamic based on settings in future
      documentSha256: event.documentHash,
      typedName: `Signed via ${settings.esign.activeProvider}`,
      ip: req.ip,
      userAgent: req.userAgent,
      authProvider: settings.esign.activeProvider,
      externalRef: envelopeId,
      evidencePath: pdfPath
    });
  }
}
