export interface SubmitConsentCommand {
  productId: string;
  userId: string;
  kind: string; // e.g., 'C3_revenue_split'
  decision: 'given' | 'declined';
  textVersion: string;
  documentSha256: string;
  typedName: string;
  ip: string;
  userAgent: string;
  authProvider: string;
  externalRef?: string;
  evidencePath?: string;
}

export interface ConsentDatabasePort {
  /**
   * Persists a consent record into the append-only evidence table.
   */
  submitConsent(command: SubmitConsentCommand): Promise<void>;
}
