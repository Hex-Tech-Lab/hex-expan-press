export interface Signer {
  name: string;
  email: string;
}

export interface CreateEnvelopeCommand {
  templateId: string;
  signers: Signer[];
  metadata: Record<string, string>;
  redirectUrl: string;
  webhookUrl: string;
}

export interface CreateEnvelopeResult {
  envelopeId: string;
  signUrl: string;
}

export interface EsignProviderPort {
  /**
   * Creates a new e-signature envelope using a pre-defined template.
   * Returns the embedded signing URL and the provider's envelope ID.
   */
  createEnvelope(command: CreateEnvelopeCommand): Promise<CreateEnvelopeResult>;
}

export interface WebhookEvent {
  eventType: 'envelope.completed' | 'unknown';
  envelopeId: string;
  metadata: Record<string, string>;
  documentHash: string;
}

export interface WebhookValidationResult {
  isValid: boolean;
  event?: WebhookEvent;
  error?: string;
}

export interface EsignWebhookPort {
  parseAndValidateWebhook(body: string, headers: Record<string, string | string[] | undefined>): WebhookValidationResult;
}
