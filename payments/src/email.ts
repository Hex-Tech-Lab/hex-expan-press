import { Resend } from "resend";
import { GLOBAL } from "./settings_registry.ts";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Plain-text part — required: HTML-only mail scores worse with spam filters. */
  text: string;
  replyTo?: string;
  /** Which outbound stream sends it (`GLOBAL.email.streams`). Defaults to buyer delivery. */
  stream?: "buyer_delivery" | "ops_alerts";
  /** Sent as Resend's Idempotency-Key: a retry with the same key and payload is not a second email (Resend keeps keys for 24 hours). */
  idempotencyKey?: string;
}

/**
 * A failed send. `retryable` is true for rate limits (429) and provider/network
 * failures (5xx, no status) — the caller may queue a retry; false means the
 * request itself is wrong (bad address, unverified domain) and must be fixed.
 *
 * `definite` is true only when the provider certainly did not accept the message: a
 * local config check failed before any request, or Resend answered with a 4xx (429 included).
 * The exception is a 409 concurrent_idempotent_requests: another request with the same idempotency key is
 * in flight, so the original may still be accepted. That outcome is ambiguous and retryable.
 * Anything else (a transport failure, a 5xx, an error with no status) is ambiguous: the message
 * may have been accepted. Callers must not treat an ambiguous failure as a non-delivery.
 */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
    readonly definite: boolean = false,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

export const isRetryableError = (
  name: string | undefined | null,
  status: number | undefined | null,
): boolean => {
  if (status === 429 || (typeof status === "number" && status >= 500)) {
    return true;
  }
  if (status === null || status === undefined) {
    if (typeof name === "string" && name.trim() !== "") {
      return GLOBAL.email.retryable_error_names.includes(name);
    }
    return true;
  }
  return false;
};

/** Extracts the address from `Name <addr>` or a bare address. */
const addressOf = (from: string): string => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

/** True when `from` is on the configured sending domain or one of its subdomains. */
export const isOnSendingDomain = (from: string, domain: string = GLOBAL.email.streams.buyer_delivery.domain): boolean => {
  const host = addressOf(from).split("@")[1] ?? "";
  const d = domain.toLowerCase();
  return host === d || host.endsWith(`.${d}`);
};

export async function sendEmail({ to, subject, html, text, replyTo, stream, idempotencyKey }: SendEmailInput): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  // The checks below run before any request, so nothing can have been sent.
  if (!apiKey) {
    throw new EmailSendError("RESEND_API_KEY is missing — cannot send email", false, undefined, true);
  }
  if (!text.trim()) {
    throw new EmailSendError("Email text part is empty — send multipart (html + text)", false, undefined, true);
  }
  const streamKey = stream ?? "buyer_delivery";
  const streamSettings = GLOBAL.email.streams[streamKey] as (typeof GLOBAL.email.streams)[keyof typeof GLOBAL.email.streams] | undefined;
  if (!streamSettings) {
    throw new EmailSendError(`Unknown email stream "${String(streamKey)}"`, false, undefined, true);
  }
  // EMAIL_FROM overrides only the buyer stream; the ops stream always uses its registry address.
  const from = streamKey === "buyer_delivery" ? process.env.EMAIL_FROM || streamSettings.from : streamSettings.from;
  if (!isOnSendingDomain(from, streamSettings.domain)) {
    throw new EmailSendError(`From address ${addressOf(from)} is not on ${streamSettings.domain}`, false, undefined, true);
  }

  const resend = new Resend(apiKey);
  let result: Awaited<ReturnType<typeof resend.emails.send>>;
  try {
    const payload = {
      from,
      to,
      subject,
      html,
      text,
      replyTo: replyTo ?? GLOBAL.email.support,
    };
    result = await (idempotencyKey !== undefined
      ? resend.emails.send(payload, { idempotencyKey })
      : resend.emails.send(payload));
  } catch (err) {
    // Network/transport failure before Resend answered.
    throw new EmailSendError(`Resend request failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }

  const { data, error } = result;
  if (error || !data) {
    const errObj = error as { name?: string | null; statusCode?: number | null } | null;
    const name = errObj?.name ?? undefined;
    const status = errObj?.statusCode ?? undefined;
    // A 4xx means Resend refused the request. Without a status, or with a 5xx, the outcome is ambiguous.
    // The concurrent-request 409 is ambiguous too: the original request with this key may still be accepted, so it is retryable.
    const concurrent = status === GLOBAL.email.concurrent_request_status && name === GLOBAL.email.concurrent_request_error_name;
    const refused = typeof status === "number" && status >= 400 && status < 500 && !concurrent;
    throw new EmailSendError(
      `Resend error${status ? ` (${status})` : ""}: ${error?.message ?? "no data"}`,
      concurrent || isRetryableError(name, status),
      status,
      refused,
    );
  }
  return { id: data.id };
}

/**
 * Non-throwing wrapper for callers on a user-facing path (e.g. a webhook that
 * already recorded a sale): email failure must never fail the primary action.
 * Logs a diagnostic line and returns the outcome for the caller to act on.
 */
export async function sendEmailSafe(
  input: SendEmailInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string; retryable: boolean }> {
  try {
    const { id } = await sendEmail(input);
    return { ok: true, id };
  } catch (err) {
    const e = err instanceof EmailSendError ? err : new EmailSendError(String(err), true);
    console.error(`[email] send failed retryable=${e.retryable} status=${e.statusCode ?? "-"}: ${e.message}`);
    return { ok: false, error: e.message, retryable: e.retryable };
  }
}
