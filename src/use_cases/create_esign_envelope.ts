import { SettingsRegistryPort } from "../domain/settings/settings.port.ts";
import { createEsignAdapter } from "../adapters/esign/esign.factory.ts";

interface CreateEsignEnvelopeRequest {
  productId: string;
  userId: string;
  userEmail: string;
  hostUrl: string; // e.g., https://expanpress.com
}

interface CreateEsignEnvelopeResponse {
  signUrl: string;
}

export async function createEsignEnvelopeUseCase(
  req: CreateEsignEnvelopeRequest,
  settingsRegistry: SettingsRegistryPort
): Promise<CreateEsignEnvelopeResponse> {
  // 1. Load configuration from settings registry (no hardcoded templates)
  const settings = await settingsRegistry.getPortalSettings();
  
  // 2. Instantiate the correct provider via cascade/factory
  const esignProvider = createEsignAdapter(settings.esign);

  // 3. Build the provider-agnostic domain command
  const command = {
    agreementPath: settings.esign.revenueSplitDocumentPath,
    signers: [{ email: req.userEmail, name: req.userEmail }], // Name uses email for now per original logic
    metadata: { productId: req.productId, userId: req.userId },
    redirectUrl: `${req.hostUrl}/creator/consents/esign_done`,
    webhookUrl: `${req.hostUrl}/api/esign/webhook` // Completely abstracts the vendor
  };

  // 4. Execute through the port interface
  const result = await esignProvider.createEnvelope(command);

  return {
    signUrl: result.signUrl
  };
}
