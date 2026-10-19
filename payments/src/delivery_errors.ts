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
