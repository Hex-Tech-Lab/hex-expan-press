/**
 * payments.port.ts — Universal Language for the Payments Domain
 *
 * SSOT for ALL payment provider contracts. Every provider adapter MUST translate
 * its provider-specific payload into these types. No provider-specific field names,
 * response shapes, or terminology may leak outside an adapter.
 *
 * ADR Reference: ADR-0049, ADR-0050
 */

// ---------------------------------------------------------------------------
// § Money — canonical internal representation
// ---------------------------------------------------------------------------

/**
 * All monetary amounts are stored as integer CENTS internally.
 * Never float. Never "amount_usd". Conversion to display units is a UI concern.
 *
 * Rationale: Every provider returns amounts differently:
 *   - Polar:        total_amount in cents (integer)
 *   - Paddle:       details.totals.total in cents (integer)
 *   - LemonSqueezy: data.attributes.total in cents (integer)
 *   - Payhip:       price in USD major units (float, e.g. "29.00")
 *   - Fungies:      data.payment.value in cents (integer)
 *   - FastSpring:   data.total in USD major units (float, e.g. "29.00")
 *
 * At the adapter boundary, ALL amounts are normalized to integer cents.
 */
export type AmountCents = number; // Always integer, always positive

/**
 * ISO 4217 3-letter currency code, always UPPERCASE.
 * Examples: "USD", "EUR", "GBP"
 */
export type CurrencyCode = string;

// ---------------------------------------------------------------------------
// § Timestamps — canonical internal representation
// ---------------------------------------------------------------------------

/**
 * All timestamps are ISO-8601 strings (UTC).
 * Adapters are responsible for converting provider-specific formats:
 *   - Polar:        created_at (ISO string)
 *   - Paddle:       changed_at (ISO string)
 *   - LemonSqueezy: created_at (ISO string)
 *   - Payhip:       date (Unix epoch seconds)
 *   - Fungies:      createdAt (Unix epoch milliseconds)
 *   - FastSpring:   changed (Unix epoch milliseconds)
 */
export type IsoTimestamp = string;

// ---------------------------------------------------------------------------
// § Identifiers
// ---------------------------------------------------------------------------

/**
 * The buyer's email address, SHA-256 hashed (hex, lowercase).
 * We NEVER store raw buyer emails. Adapters receive the plain email from the
 * provider, hash it, and discard the plain version before returning.
 *
 * Why hash? GDPR erasure compliance. Hashed email is still useful for:
 *   - Deduplication across providers
 *   - Cross-provider attribution joins
 *   - Analytics
 */
export type HashedEmail = string; // sha256 hex of trim().toLowerCase() email

/**
 * Our own canonical cross-provider attribution ID.
 * Generated client-side by the checkout page attribution script.
 * Passed through each provider's custom metadata/passthrough mechanism.
 * Optional — absent on direct/organic sales with no captured source.
 *
 * Provider passthrough mechanisms:
 *   - Polar:        order.metadata.reference_id
 *   - Paddle:       custom_data.reference_id (wiring unverified)
 *   - LemonSqueezy: meta.custom_data.reference_id (wiring unverified)
 *   - Fungies:      custom fields (wiring unverified)
 *   - Payhip:       N/A — no custom data passthrough available
 *   - FastSpring:   order tags (wiring unverified)
 */
export type AttributionId = string;

// ---------------------------------------------------------------------------
// § Events — the Universal Language
// ---------------------------------------------------------------------------

export type BillingEventType = 'sale_completed' | 'refund_issued' | 'chargeback_opened' | 'ignored';

/**
 * A confirmed, paid sale. Emitted once per transaction.
 * Adapter MUST verify the provider's signature before emitting this.
 * Adapter MUST reject test-mode/sandbox events (providers: Fungies testMode, FastSpring live=false).
 */
export interface SaleCompletedEvent {
  eventType: 'sale_completed';

  // --- Identity ---
  providerName: string;          // Internal only, NEVER exposed in API URLs or logs shown to users
  saleId: string;                // Provider's own transaction ID (used for idempotency checks)
  productId: string;             // Our own product identifier (e.g. "retirearly500k-500k-playbook")
  attributionId?: AttributionId;

  // --- Money (all provider-specific formats normalized at adapter boundary) ---
  totalCents: AmountCents;       // Always integer cents. MOR handles tax/VAT; this is the gross charge.
  currency: CurrencyCode;        // "USD", "EUR", etc.

  // --- Buyer ---
  buyerEmailHash: HashedEmail;   // sha256 of trim+lowercase email

  // --- Time ---
  occurredAt: IsoTimestamp;      // Provider event timestamp, not our receipt timestamp

  // --- Audit ---
  rawPayload: unknown;           // Full provider payload preserved for forensic audit
}

/**
 * A confirmed refund linked to a prior sale.
 * Adapter MUST link back to the original saleId.
 * Partial refunds: FastSpring supports partial refunds, but our ledger treats refunds as
 * full reversals. Partial refund webhooks from FastSpring are REJECTED with a 422 by the
 * adapter; they must be reconciled manually.
 */
export interface RefundIssuedEvent {
  eventType: 'refund_issued';

  providerName: string;
  saleId: string;                // Links back to the original SaleCompletedEvent.saleId
  refundId?: string;             // Provider-specific refund ID (Polar: refund object ID; Payhip: none)
  totalCents?: AmountCents;      // Refund amount; absent if provider does not supply it
  currency?: CurrencyCode;

  occurredAt: IsoTimestamp;
  rawPayload: unknown;
}

/**
 * A chargeback / dispute opened against a prior sale.
 * Not yet wired to any provider, but the type is reserved.
 * When wired, it MUST link back to the original saleId.
 */
export interface ChargebackOpenedEvent {
  eventType: 'chargeback_opened';
  providerName: string;
  saleId: string;
  occurredAt: IsoTimestamp;
  rawPayload: unknown;
}

/**
 * An event the adapter received and understood but deliberately skipped
 * (e.g. unpaid Polar order.created, non-sale subscription events, ignored event types).
 * The HTTP controller returns 202 for ignored events.
 */
export interface IgnoredEvent {
  eventType: 'ignored';
  providerName: string;
  reason: string;
}

export type BillingEvent =
  | SaleCompletedEvent
  | RefundIssuedEvent
  | ChargebackOpenedEvent
  | IgnoredEvent;

// ---------------------------------------------------------------------------
// § Webhook Result — adapter output contract
// ---------------------------------------------------------------------------

export interface WebhookParseSuccess {
  isValid: true;
  event: BillingEvent;
}

export interface WebhookParseFailure {
  isValid: false;
  error: string;
  httpStatus?: 400 | 401 | 422 | 500; // Hint to the controller for what to return
}

export type WebhookParseResult = WebhookParseSuccess | WebhookParseFailure;

// ---------------------------------------------------------------------------
// § Checkout Command / Result
// ---------------------------------------------------------------------------

export interface CheckoutCommand {
  productId: string;
  userId: string;
  buyerEmail: string;     // Plain email used by provider to pre-fill their checkout UI
  successUrl: string;
  attributionId?: AttributionId;
}

export interface CheckoutResult {
  checkoutUrl: string;
  providerName: string;   // Internal only
}

// ---------------------------------------------------------------------------
// § Port Interface — the contract every provider adapter must fulfill
// ---------------------------------------------------------------------------

export interface PaymentProviderPort {
  /**
   * A stable identifier for this adapter (e.g. "polar", "paddle").
   * NEVER used in external URLs or user-facing responses.
   * Used only for logging, ledger records, and Matrix Router namespacing.
   */
  readonly providerName: string;

  /**
   * Fast header-only check: can this adapter handle the given webhook?
   * Used by the composite router to pick the right adapter without parsing the body.
   * MUST be deterministic and throw-free.
   */
  canHandleWebhook(headers: Record<string, string | string[] | undefined>, body: string): boolean;

  /**
   * Validates the cryptographic signature and parses the payload.
   * MUST use a Zod schema as the SSOT for payload shape.
   * MUST normalize all monetary amounts to integer cents.
   * MUST normalize all timestamps to ISO-8601 UTC strings.
   * MUST hash buyer email before returning.
   * MUST reject test-mode/sandbox payloads with isValid: false.
   * MUST NOT throw — all errors returned as WebhookParseFailure.
   */
  parseAndValidateWebhook(
    headers: Record<string, string | string[] | undefined>,
    body: string
  ): Promise<WebhookParseResult>;

  /**
   * Generates a checkout session URL.
   * MAY be a direct static URL (simple providers) or an API call (advanced).
   */
  createCheckout(command: CheckoutCommand): Promise<CheckoutResult>;
}
