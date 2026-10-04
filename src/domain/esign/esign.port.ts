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

/**
 * Evidence operations for a completed envelope (sprint-10 audit F1).
 * The consent row must never reference an evidence PDF that was not fetched,
 * uploaded and read-back verified first — adapters own both sides because the
 * provider knows how to retrieve the signed artifact and the existing
 * fetchAgreementPdf precedent already reaches Supabase Storage from here.
 */
export interface EsignEvidencePort {
  /**
   * Retrieves the signed (completed) document bytes for an envelope.
   * Implementations must throw on any failure — a missing artifact must
   * never be papered over with empty bytes.
   */
  fetchCompletedDocument(envelopeId: string): Promise<Uint8Array>;
  /**
   * Uploads the evidence bytes to durable storage at `objectPath` and
   * verifies the write with a read-back GET. Must throw unless the object
   * round-trips; upsert semantics keep re-uploads idempotent for replays.
   */
  uploadConsentEvidence(objectPath: string, bytes: Uint8Array): Promise<void>;
}
