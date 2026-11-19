/** Why a sale's buyer delivery cannot happen. */
export type DeliveryBlockReason = "no_email" | "no_release_file";

/**
 * A sale whose buyer delivery is blocked. `httpStatus` is what the webhook answers: 422 is terminal (the provider
 * stops retrying, nothing can deliver until the payload changes); 503 is retryable (ops can fix the product's
 * release file, and a later provider retry then delivers).
 */
export class DeliveryBlockedError extends Error {
  readonly httpStatus: number;

  constructor(
    readonly reason: DeliveryBlockReason,
    readonly saleId: string,
  ) {
    super(`delivery blocked: sale ${saleId} ${reason === "no_email" ? "has no buyer email" : "has no release file"}`);
    this.name = "DeliveryBlockedError";
    this.httpStatus = reason === "no_email" ? 422 : 503;
  }
}

/**
 * A buyer send whose outcome is not confirmed (ambiguous transport or provider failure, or a held claim that could not be
 * resent). The stored claim keeps the message, so the provider's retry resends the identical email under the same
 * idempotency key. Answers 503 so the provider retries. The message carries the cause text only, never buyer data.
 */
export class DeliveryPendingError extends Error {
  readonly httpStatus = 503;

  constructor(
    readonly saleId: string,
    cause: unknown,
    /**
     * Set when the answer was cut at the request deadline while the send is still running unawaited. The sale lock must stay
     * held until it settles (never rejects), or a retry could start a second send against the same claim.
     */
    readonly backgroundWork?: Promise<void>,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`delivery unconfirmed for sale ${saleId}: ${detail}; the provider will retry`);
    this.name = "DeliveryPendingError";
  }
}

/**
 * Thrown when a conditional DB write detects that a newer lock holder already advanced the fencing token.
 * Never applied; surfaces as retryable 503 so the provider retries cleanly (or reconciles on retry).
 */
export class StaleFenceError extends Error {
  readonly httpStatus = 503;

  constructor(
    readonly resource: string,
    readonly key: string,
    readonly attemptedFence: number,
    readonly storedFence?: number,
  ) {
    super(
      storedFence !== undefined
        ? `stale fence on ${resource} (${key}): attempted ${attemptedFence}, stored ${storedFence}`
        : `stale fence on ${resource} (${key}): attempted ${attemptedFence}`,
    );
    this.name = "StaleFenceError";
  }
}
