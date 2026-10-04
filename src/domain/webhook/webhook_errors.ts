/**
 * Typed webhook error taxonomy (sprint-10 audit F5).
 *
 * Error PROSE was load-bearing: routes classified 400-vs-500 with
 * `message.includes("validation failed")`, so any rewording silently inverted
 * the provider retry contract. Classification now runs on this class;
 * messages are for humans only.
 */
export class WebhookValidationError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 400
  ) {
    super(message);
    this.name = "WebhookValidationError";
  }
}
