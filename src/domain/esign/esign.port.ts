export interface Signer {
  name: string;
  email: string;
}

export interface CreateEnvelopeCommand {
  /**
   * Provider-agnostic reference to the agreement PDF to sign.
   * Adapters resolve this to their own storage/document fetch.
   */
  agreementPath: string;
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
  /** Raw signed document / certificate download reference, when the provider supplies one. */
  documentUrl?: string;
}

export interface WebhookValidationResult {
  providerName?: string;
  isValid: boolean;
  event?: WebhookEvent;
  error?: string;
}

export interface EsignWebhookPort {
  parseAndValidateWebhook(body: string, headers: Record<string, string | string[] | undefined>): WebhookValidationResult;
}
