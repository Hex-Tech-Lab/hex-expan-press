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

export interface ConsentManualReviewFlag {
  reason: "legacy_text_version";
  kind: string;
  envelope_id: string;
  product_id: string;
  user_id: string;
  snapshot: "missing" | "malformed";
}

export interface ConsentDatabasePort {
  /**
   * Persists a consent record into the append-only evidence table.
   */
  submitConsent(command: SubmitConsentCommand): Promise<void>;
  /** Durable MANUAL_REVIEW_REQUIRED_CONSENT audit row. Throws on failure so the webhook 500s and is retried. */
  flagConsentForManualReview(flag: ConsentManualReviewFlag): Promise<void>;
}
