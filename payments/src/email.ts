import { Resend } from "resend";
import { GLOBAL } from "./settings_registry.ts";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Plain-text part — required: HTML-only mail scores worse with spam filters. */
  text: string;
  replyTo?: string;
}

/**
 * A failed send. `retryable` is true for rate limits (429) and provider/network
 * failures (5xx, no status) — the caller may queue a retry; false means the
 * request itself is wrong (bad address, unverified domain) and must be fixed.
 */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
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
export const isOnSendingDomain = (from: string, domain: string = GLOBAL.email.sending_domain): boolean => {
  const host = addressOf(from).split("@")[1] ?? "";
  const d = domain.toLowerCase();
  return host === d || host.endsWith(`.${d}`);
};

export async function sendEmail({ to, subject, html, text, replyTo }: SendEmailInput): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new EmailSendError("RESEND_API_KEY is missing — cannot send email", false);
  }
  if (!text.trim()) {
    throw new EmailSendError("Email text part is empty — send multipart (html + text)", false);
  }
  const from = process.env.EMAIL_FROM || GLOBAL.email.from;
  if (!isOnSendingDomain(from)) {
    throw new EmailSendError(`From address ${addressOf(from)} is not on ${GLOBAL.email.sending_domain}`, false);
  }

  const resend = new Resend(apiKey);
  let result: Awaited<ReturnType<typeof resend.emails.send>>;
  try {
    result = await resend.emails.send({
      from,
      to,
      subject,
      html,
      text,
      replyTo: replyTo ?? GLOBAL.email.reply_to,
    });
  } catch (err) {
    // Network/transport failure before Resend answered.
    throw new EmailSendError(`Resend request failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }

  const { data, error } = result;
  if (error || !data) {
    const errObj = error as { name?: string | null; statusCode?: number | null } | null;
    const name = errObj?.name ?? undefined;
    const status = errObj?.statusCode ?? undefined;
    throw new EmailSendError(
      `Resend error${status ? ` (${status})` : ""}: ${error?.message ?? "no data"}`,
      isRetryableError(name, status),
      status,
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
