/**
 * Buyer delivery (launch blocker, item 3). After a sale is recorded:
 *   1. mint a random download token; store only its sha256 (download_events, once per sale)
 *   2. wrap {origin}/books/d/{token} in a Dub short link (go.expanpress.com)
 *   3. email the buyer the link via Resend
 * GET /books/d/{token} then validates the hash and expiry, logs download_completed, and 302s to a
 * 300-second signed URL for the release file. Only the server-side log makes the served-download
 * claim; it records that a signed URL was issued, not that the browser finished the transfer.
 *
 * Failure policy: the ledger write is the money record and stays authoritative. A delivery failure
 * is rethrown to the webhook as a DeliveryPendingError (503, so the provider retries) whenever the send's outcome is unknown or a message
 * store failed, even when the read-back shows nothing stored (a stale fence is rethrown unchanged). The original error is
 * rethrown for a definite non-send before the store, or a definite provider 4xx rejection other than an address refusal. A
 * definite 422 from the mail provider (GLOBAL.email.address_rejected_status: the message was refused, and no retry can succeed)
 * is answered by deliverSaleForWebhook as DeliveryBlockedError('no_email'): 422, terminal. The sale stays booked, the webhook
 * quarantines the event, and an operator is flagged: a console line here (flagForManualReconciliation), plus a
 * WEBHOOK_TERMINAL_REJECT audit row that scripts/ops/stuck_report.ts lists under "Terminal webhook rejects" (the operator path).
 * A 401 or 403 is a config refusal and stays retryable. A download_events
 * row is released only on a verified non-send. A sale counts as delivered only once its send is confirmed (an audit_log row with
 * event DELIVERY_LINK_SENT, scoped to the provider that issued the sale).
 *
 * Held claims (PR 136 H1): before the send, the rendered buyer message is stored encrypted on the claim row
 * (delivery_sends.link_ciphertext, AES-256-GCM, key from DELIVERY_LINK_KEY). A retry for a held or unconfirmed claim
 * resends those exact bytes under the same Resend idempotency key (provider|saleId|sendKind), so it cannot become a
 * second distinct email. The resend first confirms that the link is still issued and unexpired (download_events), so a
 * dead link is never emailed. The stored message is cleared in the same write that marks the claim 'sent', which runs only
 * after the receipt is confirmed. A resend is refused once its claim is older than delivery.stored_message_resend_max_age_hours
 * (default 24, the Resend idempotency window): the key may have expired, so the send could be a second email. It is flagged
 * for manual reconciliation instead.
 *
 * A claim with NO stored message (PR 136 review H1, H5):
 *   - a sent-but-unconfirmed claim with no message is never resent: this code clears the message only in the sent write,
 *     after confirmation, so such a row is legacy. It is flagged for manual reconciliation and answers 503;
 *   - a held claim created before delivery.stored_message_since is legacy: it may have been sent without a message. It is
 *     never resent and never re-minted; it is flagged and answers 503;
 *   - a held claim created at or after that instant with no message was never sent: this code stores the message before any
 *     send, so the store must have failed before landing. It is minted fresh. This keeps an in-flight claim from stranding.
 * A store that failed and was read back as landed nowhere releases its claim, so the retry starts clean.
 */
import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_GLOBAL, GLOBAL, paymentProviderProductIdColumn } from "./settings_registry.ts";
import { EmailSendError, sendEmail as realSendEmail } from "./email.ts";
import { DeliveryBlockedError, DeliveryPendingError, StaleFenceError } from "./delivery_errors.ts";
import { createDeliverySendsStore, type DeliverySendClaim } from "./delivery_sends_store.ts";
import { claimMessageKeyId, decryptClaimMessage, encryptClaimMessage, loadDeliveryLinkKey } from "./delivery_link_crypto.ts";
import { getSupabaseAdmin } from "./supabase_admin.ts";
import { bounded, budgetLeftMs, requestSignal, webhookDeadlineAt } from "./webhook_budget.ts";

export { StaleFenceError, DeliveryPendingError, type DeliverySendClaim };

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** audit_log event written once a link's send is accepted. Its absence marks a sale as not yet delivered. */
const DELIVERY_CONFIRMED_EVENT = "DELIVERY_LINK_SENT";

/** Resend's documented Idempotency-Key limit. A longer key is refused before any claim is written. */
const RESEND_IDEMPOTENCY_KEY_MAX_CHARS = 256;

export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
export const newToken = (): string => randomBytes(32).toString("base64url");

let lastGeneration = 0;

/**
 * Monotonically increasing generation number for download link issuance.
 * Ensures same-millisecond retries never produce duplicate generation timestamps.
 */
export function nextGeneration(nowMs: number): number {
  const gen = Math.max(nowMs, lastGeneration + 1);
  lastGeneration = gen;
  return gen;
}

/** Reset helper for test determinism. */
export function resetLastGenerationForTest(val = 0): void {
  lastGeneration = val;
}

export interface DeliveryProduct {
  id: string;
  title: string;
  releasePath: string | null;
}

/** The persistence the delivery flow needs. Injected so the flow is testable without a database. */
export interface DeliveryDb {
  productForAlias(provider: string, alias: string): Promise<DeliveryProduct | null>;
  /** Inserts the link_issued row. Returns false on generation collision (sale_id, link_generation). */
  recordLinkIssued(row: {
    saleId: string;
    productId: string;
    tokenHash: string;
    expiresAt: Date;
    linkGeneration?: number;
  }): Promise<boolean>;
  /** Removes the link_issued row for this sale and token, so a later attempt can issue again. */
  releaseLinkIssued(row: { saleId: string; tokenHash: string }): Promise<void>;
  /** True when this sale's link_issued row for the token exists and has not expired at `now`. A resend is refused without it. */
  linkStillIssued(row: { saleId: string; tokenHash: string; now: Date }): Promise<boolean>;
  /** True once a send for this provider's sale has been confirmed accepted. Sale IDs are scoped by provider. */
  deliveryConfirmed(provider: string, saleId: string): Promise<boolean>;
  /** Records that the send for this provider's sale link was accepted. Called only after the send resolves. */
  confirmDelivery(row: { provider: string; saleId: string; tokenHash: string }): Promise<void>;
  /** Option A + B: atomically claims (provider, saleId, sendKind) with ON CONFLICT DO NOTHING and fence check. */
  claimDeliverySend(row: {
    provider: string;
    saleId: string;
    sendKind: string;
    fence?: number;
  }): Promise<DeliverySendClaim>;
  /** Option B: conditional fence verification immediately before sending email. */
  assertSendFence(row: {
    provider: string;
    saleId: string;
    sendKind: string;
    fence: number;
  }): Promise<void>;
  /**
   * Transitions claim to 'sent' only when stored fence <= new fence, and clears the stored buyer message in the same write.
   * Call only after the receipt is confirmed: a 'sent' row keeps no message to resend.
   */
  markDeliverySent(row: {
    provider: string;
    saleId: string;
    sendKind: string;
    fence?: number;
  }): Promise<void>;
  /** Releases a 'claimed' row only when no send was attempted or provider definitely refused. */
  releaseDeliverySend(row: {
    provider: string;
    saleId: string;
    sendKind: string;
    fence?: number;
  }): Promise<void>;
  /**
   * Stores the encrypted buyer message on this claim before any send. First writer wins, and fenced: a write that matches no
   * row (a newer worker owns the claim, or a message is already stored) throws StaleFenceError. The caller must not send.
   */
  storeClaimMessage(row: {
    provider: string;
    saleId: string;
    sendKind: string;
    fence?: number;
    ciphertext: string;
  }): Promise<void>;
  /** The stored encrypted buyer message for this claim, or null when none was stored. */
  readClaimMessage(row: { provider: string; saleId: string; sendKind: string }): Promise<string | null>;
}

export interface DeliveryDeps {
  db: DeliveryDb;
  sendEmail: (input: {
    to: string;
    subject: string;
    html: string;
    text: string;
    replyTo?: string;
    idempotencyKey?: string;
  }) => Promise<unknown>;
  /** `timeoutMs` is the time left in the request budget: the link call must not outlast it. */
  createShortLink: (targetUrl: string, timeoutMs?: number) => Promise<string>;
  origin: string;
  replyTo: string;
  /** Dedicated billing/refund inquiry address (`GLOBAL.email.billing`), shown when distinct from `replyTo`. */
  billingEmail?: string;
  now?: () => Date;
  newToken?: () => string;
  /** Optional cap on each send, below the request budget. Tests and operator tools only; the request budget always applies. */
  timeoutMs?: number;
  /**
   * AES-256-GCM key for the stored claim message. Defaults to the key named by delivery.link_key_env. A missing or malformed
   * key throws before any send (fail closed).
   */
  linkKey?: Buffer;
}

/**
 * The send's own timer fired before the provider answered. The send is not aborted and may still complete. `settled` resolves
 * when the send ends and never rejects: the sale lock holder waits on it, so a retry cannot start a second send on the same claim.
 */
class SendTimedOutError extends Error {
  constructor(
    readonly ms: number,
    readonly settled: Promise<void>,
  ) {
    super(`email send timed out after ${ms}ms`);
    this.name = "SendTimedOutError";
  }
}

/** The settlement of a send that is still running after its timer answered. Undefined for any other failure: that send has ended. */
function sendBackgroundOf(err: unknown): Promise<void> | undefined {
  return err instanceof SendTimedOutError ? err.settled : undefined;
}

/** Rejects with onTimeout() if the promise has not settled within ms. The work is not aborted and may still complete. */
function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Time left for one send: the request budget, capped by the optional dependency cap (`deps.timeoutMs`). */
function sendBudgetMs(deps: DeliveryDeps, deadlineAt: number): number {
  const left = budgetLeftMs(deadlineAt);
  return deps.timeoutMs === undefined ? left : Math.min(left, deps.timeoutMs);
}

/** Throws the budget 503 (DeliveryPendingError) when the request budget is spent. Called before each step that starts an external call. */
function assertBudget(deadlineAt: number, saleId: string): void {
  if (budgetLeftMs(deadlineAt) <= 0) {
    throw new DeliveryPendingError(saleId, new Error("webhook budget exhausted (payments.webhook_total_budget_ms)"));
  }
}

/**
 * Flags a claim that a retry cannot resend safely, for an operator to reconcile (listStuckDeliveryClaims). Logs at error
 * level with the sale id and provider only: never the buyer email, the link or the ciphertext.
 */
function flagForManualReconciliation(provider: string, saleId: string, sendKind: string, reason: string): void {
  console.error(
    `[delivery] MANUAL RECONCILE sale=${saleId} provider=${provider} send_kind=${sendKind}: ${reason}. ` +
      "The sale stays unresolved until an operator reconciles it.",
  );
}

/**
 * True when a held claim predates the stored-message change, or when its creation time is unknown (fail closed). Such a claim
 * may have been sent without a stored message, so it is never re-minted. delivery.stored_message_since is the cutover.
 */
function isLegacyClaim(claimedAt: string | undefined): boolean {
  const created = claimedAt === undefined ? Number.NaN : Date.parse(claimedAt);
  return !(created >= Date.parse(GLOBAL.delivery.stored_message_since));
}

/**
 * Releases a definite non-send: the claim, then its link. The claim goes first. A claim kept with its message still points
 * at a live link, which is safe to resend. A link dropped under a kept claim would email a dead link, so that order is never
 * used. A failure to release the claim throws, and the link is then kept with it. A failure to release the link only leaves an
 * orphan row that no claim points at, so it is logged and not thrown.
 */
async function releaseVerifiedNonSend(
  input: { provider: string; saleId: string; sendKind: string; fence?: number; releaseClaim: boolean; linkInserted: boolean; tokenHash: string },
  deps: DeliveryDeps,
): Promise<void> {
  if (input.releaseClaim) {
    await deps.db.releaseDeliverySend({ provider: input.provider, saleId: input.saleId, sendKind: input.sendKind, fence: input.fence });
  }
  if (input.linkInserted) {
    try {
      await deps.db.releaseLinkIssued({ saleId: input.saleId, tokenHash: input.tokenHash });
    } catch (releaseErr) {
      console.error(`[delivery] sale ${input.saleId}: could not release link row (orphan; no claim points at it): ${String(releaseErr)}`);
    }
  }
}

export type DeliveryOutcome = "sent" | "duplicate" | "no_email" | "no_release_file";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A font-family list for the buyer email's inline style: unquoted words start with an optional single leading hyphen + ASCII
// letter (rejecting digit-led CSS tokens), or single/double-quoted font names, separated by commas. Nothing else (no ; { }
// < > outside a quoted name, no parentheses, no backslashes).
const EMAIL_FONT_STACK_RE =
  /^(?:-?[A-Za-z][A-Za-z0-9-]*(?: -?[A-Za-z][A-Za-z0-9-]*)*|'[A-Za-z0-9 -]+'|"[A-Za-z0-9 -]+")(?:\s*,\s*(?:-?[A-Za-z][A-Za-z0-9-]*(?: -?[A-Za-z][A-Za-z0-9-]*)*|'[A-Za-z0-9 -]+'|"[A-Za-z0-9 -]+"))*$/;

/** Returns the trimmed stack when it matches the grammar; otherwise the registry default, with a warning that names the key only. */
export function safeEmailFontStack(value: string): string {
  const candidate = value.trim();
  if (EMAIL_FONT_STACK_RE.test(candidate)) return candidate;
  console.warn("[delivery] email_font_stack is not a safe font stack; using the registry default");
  return DEFAULT_GLOBAL.branding.email_font_stack;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The buyer email as rendered once. Stored encrypted on the claim, so a retry sends these exact bytes. */
interface BuyerMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo: string;
  tokenHash: string;
}

function buildBuyerMessage(args: {
  to: string;
  title: string;
  link: string;
  days: number;
  replyTo: string;
  billingEmail?: string;
  tokenHash: string;
  /** Calendar year for the footer copyright, resolved by the caller at send time. */
  year: number;
}): BuyerMessage {
  const { to, title, link, days, replyTo, billingEmail, tokenHash: hash, year } = args;
  const billingNote = billingEmail && billingEmail !== replyTo ? ` (billing or refund questions: ${billingEmail})` : "";
  const billingHtml = billingEmail && billingEmail !== replyTo ? ` (billing or refund questions: ${esc(billingEmail)})` : "";
  const brand = GLOBAL.storefront.brand_name;
  const wordmark = brand.toLowerCase();
  const colors = GLOBAL.branding.colors;
  const fontStack = esc(safeEmailFontStack(GLOBAL.branding.email_font_stack));
  const safeTitle = esc(title);
  const safeLink = esc(link);
  const safeReplyTo = esc(replyTo);
  const safeBrand = esc(brand);
  const safeWordmark = esc(wordmark);
  const html =
    `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:${colors.canvas};font-family:${fontStack};color:${colors.charcoal};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${colors.canvas};padding:32px 16px;">` +
    `<tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${colors.surface};border:1px solid ${colors.border};border-radius:24px;padding:32px;">` +
    `<tr><td style="padding-bottom:20px;font-size:20px;font-weight:700;letter-spacing:-0.025em;color:${colors.charcoal};">` +
    `<span style="color:${colors.muted};font-weight:300;">{</span>${safeWordmark}<span style="color:${colors.muted};font-weight:300;">}</span>` +
    `</td></tr>` +
    `<tr><td style="font-size:16px;line-height:1.6;color:${colors.charcoal};padding-bottom:16px;">` +
    `Thank you for your purchase of <strong>${safeTitle}</strong>.` +
    `</td></tr>` +
    `<tr><td style="padding-bottom:20px;">` +
    `<a href="${safeLink}" style="display:inline-block;background:${colors.button_primary};color:${colors.button_text};text-decoration:none;font-size:14px;font-weight:600;padding:14px 24px;border-radius:9999px;">Download your book</a>` +
    `</td></tr>` +
    `<tr><td style="font-size:13px;line-height:1.5;color:${colors.muted};padding-bottom:16px;word-break:break-all;">` +
    `Download your copy here (the link is valid for ${days} days):<br>` +
    `<a href="${safeLink}" style="color:${colors.charcoal};text-decoration:underline;">${safeLink}</a>` +
    `</td></tr>` +
    `<tr><td style="border-top:1px solid ${colors.border};padding-top:16px;font-size:12px;line-height:1.5;color:${colors.subtle};">` +
    `Questions? Reply to this email or write to ${safeReplyTo}${billingHtml}.<br>` +
    `&copy; ${year} ${safeBrand}` +
    `</td></tr>` +
    `</table>` +
    `</td></tr></table></body></html>`;
  return {
    to,
    // Per-link reference (token hash prefix): Gmail threads identical subjects, so each link needs its own.
    subject: `Your download: ${title} (ref ${hash.slice(0, GLOBAL.delivery.subject_ref_chars).toUpperCase()})`,
    text:
      `Thank you for your purchase of ${title}.\n\n` +
      `Download your copy here (the link is valid for ${days} days):\n${link}\n\n` +
      `Questions? Reply to this email or write to ${replyTo}${billingNote}.\n`,
    html,
    replyTo,
    tokenHash: hash,
  };
}

/** Parses a decrypted stored message. Every field must be a string, or the message is refused. */
function parseBuyerMessage(json: string): BuyerMessage {
  const parsed = JSON.parse(json) as Partial<Record<keyof BuyerMessage, unknown>>;
  for (const field of ["to", "subject", "text", "html", "replyTo", "tokenHash"] as const) {
    if (typeof parsed[field] !== "string") throw new Error(`delivery: stored claim message field ${field} is not a string`);
  }
  return parsed as BuyerMessage;
}

/** The provider idempotency key for one sale send: provider|saleId|sendKind. Also the AAD that binds the ciphertext to its row. */
function claimKey(provider: string, saleId: string, sendKind: string): string {
  return `${provider}|${saleId}|${sendKind}`;
}

async function sendBuyerMessage(deps: DeliveryDeps, message: BuyerMessage, idempotencyKey: string, deadlineMs: number): Promise<void> {
  const send = deps.sendEmail({
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    replyTo: message.replyTo,
    idempotencyKey,
  });
  // Never rejects. If the timer answers first, the caller hands this to the lock holder (see sendBackgroundOf).
  const settled = send.then(() => undefined, () => undefined);
  await withDeadline(send, deadlineMs, () => new SendTimedOutError(deadlineMs, settled));
}

/**
 * Resends the identical stored message under the same idempotency key. A failure to decrypt the message, to confirm its link
 * is still issued and unexpired, to check the resend window, or to send answers 503 (DeliveryPendingError), and the stored
 * message is kept, so the next retry sends the same bytes again. A stale fence is rethrown. A definite refusal of the buyer
 * address is rethrown unchanged: 422, terminal, as on the first send. Nothing is sent
 * unless the message decrypts and its link is still issued and unexpired; otherwise the buyer would get a dead link marked
 * as delivered. The receipt is re-checked right before the send, and the claim must be inside the resend window. The receipt
 * re-check runs outside the send's try: a database failure there throws its own error, which the webhook answers 500.
 */
async function resendStoredMessage(
  input: { provider: string; saleId: string; fence?: number },
  key: { provider: string; saleId: string; sendKind: string },
  stored: string,
  claim: DeliverySendClaim,
  deps: DeliveryDeps,
  deadlineAt: number,
): Promise<DeliveryOutcome> {
  const idempotencyKey = claimKey(key.provider, key.saleId, key.sendKind);
  let message: BuyerMessage;
  try {
    const linkKey = deps.linkKey ?? loadDeliveryLinkKey();
    message = parseBuyerMessage(decryptClaimMessage(stored, linkKey, idempotencyKey));
  } catch (err) {
    // Logged once per attempt. The key id names the envelope's key so a rotation or a corrupt row is diagnosable.
    console.error(
      `[delivery] sale ${input.saleId} provider=${input.provider}: stored claim message is unreadable (link key id ${claimMessageKeyId(stored) ?? "unknown"}); ` +
        `not sent, answering 503. Check DELIVERY_LINK_KEY against that key id. ${errorText(err)}`,
    );
    throw new DeliveryPendingError(input.saleId, err);
  }
  const now = deps.now ? deps.now() : new Date();
  let live: boolean;
  try {
    live = await deps.db.linkStillIssued({ saleId: input.saleId, tokenHash: message.tokenHash, now });
  } catch (err) {
    throw new DeliveryPendingError(input.saleId, err);
  }
  if (!live) {
    flagForManualReconciliation(
      input.provider,
      input.saleId,
      key.sendKind,
      "the stored buyer message points at a link that is no longer issued or has expired; not sent",
    );
    throw new DeliveryPendingError(input.saleId, new Error("the download link for this sale is no longer issued"));
  }
  // Re-check right before the send: a concurrent worker may have confirmed the receipt since deliverSale's first check. A
  // confirmed sale is a duplicate and nothing is sent. A held row is closed here, as the first check closes it.
  if (await deps.db.deliveryConfirmed(key.provider, input.saleId)) {
    if (claim.outcome === "already_claimed") {
      await deps.db.markDeliverySent({ provider: key.provider, saleId: key.saleId, sendKind: key.sendKind, fence: input.fence });
    }
    return "duplicate";
  }
  // The provider's idempotency window bounds the resend. The claim is created before the first send, so its creation time is
  // the earliest the key can have started: measuring from it refuses sooner than the key expires, never later. An unknown
  // creation time is not within the cap (fail closed), as in isLegacyClaim.
  const maxAgeMs = GLOBAL.delivery.stored_message_resend_max_age_hours * 60 * 60 * 1000;
  const claimedMs = claim.claimedAt === undefined ? Number.NaN : Date.parse(claim.claimedAt);
  if (!(now.getTime() - claimedMs <= maxAgeMs)) {
    const reason =
      `the claim is older than delivery.stored_message_resend_max_age_hours (${GLOBAL.delivery.stored_message_resend_max_age_hours}h) or has no known creation time; ` +
      "not resent, because the provider may no longer hold its idempotency key";
    flagForManualReconciliation(key.provider, input.saleId, key.sendKind, reason);
    throw new DeliveryPendingError(input.saleId, new Error(reason));
  }
  // No send without time left in the request budget: the stored message stays, and the next retry resends it.
  assertBudget(deadlineAt, input.saleId);
  try {
    await sendBuyerMessage(deps, message, idempotencyKey, sendBudgetMs(deps, deadlineAt));
    await deps.db.confirmDelivery({ provider: key.provider, saleId: key.saleId, tokenHash: message.tokenHash });
    await deps.db.markDeliverySent({ provider: key.provider, saleId: key.saleId, sendKind: key.sendKind, fence: input.fence });
  } catch (err) {
    if (err instanceof StaleFenceError) throw err;
    // A definite refusal of the buyer address is terminal, as on the first send. It is rethrown unchanged, so
    // deliverSaleForWebhook answers 422 and flags the sale. The claim and the stored message are kept: an earlier send under
    // this key may have been accepted, so nothing here releases them.
    if (isBuyerAddressRejection(err)) throw err;
    throw new DeliveryPendingError(input.saleId, err, sendBackgroundOf(err));
  }
  return "sent";
}

export async function deliverSale(
  input: {
    provider: string;
    saleId: string;
    productAlias: string;
    buyerEmail?: string;
    sendKind?: string;
    fence?: number;
    /** Absolute epoch-ms answer deadline for this request. Defaults to the webhook total budget counted from now. */
    deadlineAt?: number;
  },
  deps: DeliveryDeps,
): Promise<DeliveryOutcome> {
  if (input.fence !== undefined && (typeof input.fence !== "number" || !Number.isSafeInteger(input.fence) || input.fence < 0)) {
    throw new TypeError("delivery: fence token must be a non-negative safe integer");
  }
  const sendKind = input.sendKind ?? GLOBAL.delivery?.send_kind;
  if (typeof sendKind !== "string" || sendKind.trim() === "") {
    throw new Error("delivery: delivery.send_kind is missing in settings registry");
  }
  if (!input.buyerEmail) return "no_email";
  const key = { provider: input.provider, saleId: input.saleId, sendKind };
  const idempotencyKey = claimKey(input.provider, input.saleId, sendKind);
  if (idempotencyKey.length > RESEND_IDEMPOTENCY_KEY_MAX_CHARS) {
    throw new Error(`delivery: idempotency key for sale ${input.saleId} exceeds ${RESEND_IDEMPOTENCY_KEY_MAX_CHARS} characters`);
  }
  const deadlineAt = input.deadlineAt ?? webhookDeadlineAt();
  assertBudget(deadlineAt, input.saleId);
  const runPreSendStep = async <T>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (err) {
      if (budgetLeftMs(deadlineAt) <= 0 && !(err instanceof StaleFenceError)) {
        throw new DeliveryPendingError(input.saleId, err);
      }
      throw err;
    }
  };
  const product = await runPreSendStep(() => deps.db.productForAlias(input.provider, input.productAlias));
  // Fail closed on a product with no release file: a buyer must never get a link to nothing.
  if (!product || !product.releasePath) return "no_release_file";

  // Option A + Option B: claim the single-send row BEFORE creating any download link or sending email
  // (and before deliveryConfirmed so stale-fence workers are rejected even after completion).
  const claim = await runPreSendStep(() =>
    deps.db.claimDeliverySend({
      provider: input.provider,
      saleId: input.saleId,
      sendKind,
      fence: input.fence,
    }),
  );
  if (claim.outcome !== "claimed") {
    const held = claim.outcome === "already_claimed";
    if (await runPreSendStep(() => deps.db.deliveryConfirmed(input.provider, input.saleId))) {
      // Confirmed before this attempt: the buyer already has the receipt. A legacy held row is closed here.
      if (held) {
        await runPreSendStep(() =>
          deps.db.markDeliverySent({ provider: input.provider, saleId: input.saleId, sendKind, fence: input.fence }),
        );
      }
      return "duplicate";
    }
    // Held or sent-but-unconfirmed with a stored message: resend the identical bytes under the same key.
    const stored = await runPreSendStep(() => deps.db.readClaimMessage(key));
    if (stored !== null) return await resendStoredMessage(input, key, stored, claim, deps, deadlineAt);
    // No stored message. A held claim created after the change was never sent (the message is stored before any send), so it is
    // minted below. Every other case may already have been sent: nothing is sent or re-minted. The 503 path keeps the claim for
    // an operator to reconcile.
    if (!held || isLegacyClaim(claim.claimedAt)) {
      const reason = held
        ? "held claim created before the stored-message change with no stored buyer message; not resent (it may already have been sent)"
        : "sent without a confirmation and no stored buyer message; not resent (it may already have been delivered)";
      flagForManualReconciliation(input.provider, input.saleId, sendKind, reason);
      throw new DeliveryPendingError(input.saleId, new Error(reason));
    }
  }

  const now = deps.now ? deps.now() : new Date();
  const token = (deps.newToken ?? newToken)();
  const expiresAt = new Date(now.getTime() + GLOBAL.delivery.link_ttl_days * 24 * 60 * 60 * 1000);
  const hash = tokenHash(token);
  let linkGeneration = nextGeneration(now.getTime());
  let row = { saleId: input.saleId, productId: product.id, tokenHash: hash, expiresAt, linkGeneration };

  let linkInserted = false;
  let storeAttempted = false;
  let sendAttempted = false;
  const confirmExistingAsDuplicate = async (): Promise<boolean> => {
    if (!(await deps.db.deliveryConfirmed(input.provider, input.saleId))) return false;
    await deps.db.markDeliverySent({
      provider: input.provider,
      saleId: input.saleId,
      sendKind,
      fence: input.fence,
    });
    return true;
  };
  try {
    // Legacy audit-log check (e.g. sales confirmed before public.delivery_sends existed).
    if (await confirmExistingAsDuplicate()) return "duplicate";

    const MAX_GENERATION_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      linkInserted = await deps.db.recordLinkIssued(row);
      if (linkInserted) break;
      // If a concurrent worker completed delivery while we were attempting issuance:
      if (await confirmExistingAsDuplicate()) return "duplicate";
      // Monotonic generation retry without destroying prior links:
      linkGeneration = nextGeneration(Math.max(now.getTime(), linkGeneration + 1));
      row = { ...row, linkGeneration };
    }

    if (!linkInserted) {
      if (await confirmExistingAsDuplicate()) return "duplicate";
      throw new Error(`delivery blocked: sale ${input.saleId} link generation collision`);
    }

    assertBudget(deadlineAt, input.saleId);
    const link = await deps.createShortLink(`${deps.origin}/books/d/${token}`, budgetLeftMs(deadlineAt));
    if (input.fence !== undefined) {
      await deps.db.assertSendFence({
        provider: input.provider,
        saleId: input.saleId,
        sendKind,
        fence: input.fence,
      });
    }
    const message = buildBuyerMessage({
      to: input.buyerEmail,
      title: product.title,
      link,
      days: GLOBAL.delivery.link_ttl_days,
      replyTo: deps.replyTo,
      billingEmail: deps.billingEmail,
      tokenHash: hash,
      year: new Date().getUTCFullYear(),
    });
    // The exact bytes are stored BEFORE the send. A fenced write: a newer worker that owns the claim makes this stale, and
    // nothing is sent. A missing link key throws here, before any write, so the claim is released below.
    const ciphertext = encryptClaimMessage(JSON.stringify(message), deps.linkKey ?? loadDeliveryLinkKey(), idempotencyKey);
    storeAttempted = true;
    await deps.db.storeClaimMessage({
      provider: input.provider,
      saleId: input.saleId,
      sendKind,
      fence: input.fence,
      ciphertext,
    });
    assertBudget(deadlineAt, input.saleId);
    sendAttempted = true;
    await sendBuyerMessage(deps, message, idempotencyKey, sendBudgetMs(deps, deadlineAt));
  } catch (err) {
    if (!sendAttempted && storeAttempted) {
      // The store may have landed (lost response), or another worker already holds the message. A newer fence owner keeps its claim.
      if (err instanceof StaleFenceError) throw err;
      // Read back. If no message landed, nothing was stored and nothing was sent: a verified non-send, so the claim and link are
      // released and the retry starts clean. If a message landed, both are kept and the retry resends that message.
      let nothingStored = false;
      try {
        nothingStored = (await deps.db.readClaimMessage(key)) === null;
      } catch (readErr) {
        console.error(`[delivery] sale ${input.saleId}: could not read back the claim message after a failed store: ${errorText(readErr)}`);
      }
      if (nothingStored) {
        try {
          await releaseVerifiedNonSend({ ...key, fence: input.fence, releaseClaim: true, linkInserted, tokenHash: hash }, deps);
        } catch (releaseErr) {
          console.error(`[delivery] sale ${input.saleId}: could not release the claim after a failed store: ${errorText(releaseErr)}`);
        }
      }
      throw new DeliveryPendingError(input.saleId, err);
    }
    // Release ONLY when no email could have been accepted: before the store and the send, or on a definite provider 4xx
    // rejection (409 concurrent_idempotent_requests is not definite). On an ambiguous send failure keep BOTH rows so the retry
    // resends the stored message.
    const definiteNonSend = !sendAttempted || (err instanceof EmailSendError && err.definite);
    if (!definiteNonSend) throw new DeliveryPendingError(input.saleId, err, sendBackgroundOf(err));
    try {
      await releaseVerifiedNonSend(
        { ...key, fence: input.fence, releaseClaim: !(err instanceof StaleFenceError), linkInserted, tokenHash: hash },
        deps,
      );
    } catch (releaseErr) {
      // The claim could not be released, so it keeps its state, and its link stays with it. The retry is safe: it resends the
      // stored message against a live link, or flags the claim if it was created before the change.
      console.error(`[delivery] sale ${input.saleId}: could not release send claim: ${errorText(releaseErr)}`);
    }
    // A pre-send step cut by the request budget is a retryable 503, not a raw 500 with no Retry-After.
    if (budgetLeftMs(deadlineAt) <= 0 && !(err instanceof StaleFenceError) && !(err instanceof EmailSendError)) {
      throw new DeliveryPendingError(input.saleId, err);
    }
    throw err;
  }
  try {
    // Receipt first, then the sent write that clears the stored message. A failed confirmation keeps the message for the resend.
    await deps.db.confirmDelivery({ provider: input.provider, saleId: input.saleId, tokenHash: hash });
    await deps.db.markDeliverySent({
      provider: input.provider,
      saleId: input.saleId,
      sendKind,
      fence: input.fence,
    });
  } catch (err) {
    // The email was accepted but the receipt is not confirmed. Retryable: the retry resends the identical message.
    if (err instanceof StaleFenceError) throw err;
    throw new DeliveryPendingError(input.saleId, err);
  }
  return "sent";
}

/** Dub short link for a target URL. Needs DUB_API_KEY in the environment. */
export async function createDubShortLink(
  targetUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = GLOBAL.payments.http_timeout_ms,
): Promise<string> {
  const key = process.env.DUB_API_KEY;
  if (!key) throw new Error("DUB_API_KEY is missing — cannot create the download short link");
  // Bounded by the webhook-internal budget: this call runs while the sale's idempotency lock is held.
  const res = await fetchImpl("https://api.dub.co/links", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: targetUrl, domain: GLOBAL.delivery.short_domain }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Dub link create failed: HTTP ${res.status}`);
  const body = (await res.json()) as { shortLink?: unknown };
  if (typeof body.shortLink !== "string" || !body.shortLink.startsWith("https://")) {
    throw new Error("Dub link create returned no shortLink");
  }
  return body.shortLink;
}

/**
 * True once the buyer's receipt for this provider's sale is confirmed sent (DELIVERY_LINK_SENT). The webhook lock uses
 * this to decide whether a contended, already-recorded sale can be acknowledged: a recorded sale alone is not delivered.
 * A lookup failure throws, so the caller answers retryable.
 */
export function saleDeliveryConfirmed(provider: string, saleId: string, deadlineAt?: number): Promise<boolean> {
  return supabaseDeliveryDb(requestSignal(deadlineAt)).deliveryConfirmed(provider, saleId);
}

/**
 * Cleanup and post-send confirmation writes must still land after the request deadline: aborting them strands a claim
 * with no stored link, or leaves an accepted email unconfirmed. Each runs on a fresh signal bounded by
 * payments.http_timeout_ms instead of the expiring request signal.
 */
function withFreshCleanupSignals(budgeted: DeliveryDb): DeliveryDb {
  const fresh = (): DeliveryDb => supabaseDeliveryDb(AbortSignal.timeout(GLOBAL.payments.http_timeout_ms));
  return {
    ...budgeted,
    releaseLinkIssued: (row) => fresh().releaseLinkIssued(row),
    confirmDelivery: (row) => fresh().confirmDelivery(row),
    markDeliverySent: (row) => fresh().markDeliverySent(row),
    releaseDeliverySend: (row) => fresh().releaseDeliverySend(row),
    readClaimMessage: (row) => fresh().readClaimMessage(row),
  };
}

/** Production wiring: Supabase for persistence, Resend for mail, Dub for the short link. */
export function productionDeps(deadlineAt?: number): DeliveryDeps {
  const origin = GLOBAL.delivery.download_origin;
  const replyTo = GLOBAL.email.support;
  const billingEmail = GLOBAL.email.billing;
  return {
    db: deadlineAt === undefined ? supabaseDeliveryDb() : withFreshCleanupSignals(supabaseDeliveryDb(requestSignal(deadlineAt))),
    sendEmail: realSendEmail,
    createShortLink: (u, timeoutMs) => createDubShortLink(u, fetch, timeoutMs),
    origin,
    replyTo,
    billingEmail,
  };
}

/**
 * A definite refusal of the message by the mail provider at GLOBAL.email.address_rejected_status. In practice this is the
 * buyer address. The refused send was not accepted, and a retry with the same address cannot succeed.
 */
function isBuyerAddressRejection(err: unknown): err is EmailSendError {
  return err instanceof EmailSendError && err.definite && err.statusCode === GLOBAL.email.address_rejected_status;
}

/**
 * Webhook entry point. A delivery failure is rethrown and answers the error's own status: 503 with Retry-After for a
 * DeliveryPendingError, 422 (terminal) for a DeliveryBlockedError with no buyer email or a buyer address the mail provider
 * refused, 503 for one with no release file, and 500 for any other error. The provider retries the 503 and 500 answers. A sale
 * that cannot be delivered also throws: the buyer is owed a link, so the webhook must not acknowledge the sale as delivered.
 */
export async function deliverSaleForWebhook(
  input: {
    provider: string;
    saleId: string;
    productAlias: string;
    buyerEmail?: string;
    sendKind?: string;
    fence?: number;
    /** Absolute epoch-ms answer deadline for this request (payments.webhook_total_budget_ms). */
    deadlineAt?: number;
  },
  deps: DeliveryDeps = productionDeps(input.deadlineAt ?? webhookDeadlineAt()),
): Promise<void> {
  let outcome: DeliveryOutcome;
  try {
    outcome = await deliverSale(input, deps);
  } catch (err) {
    // On a first send, deliverSale has released the claim and the link (a definite rejection is a verified non-send). On a held
    // resend it keeps them, since an earlier send under the key may have been accepted. Either way the 500 that a raw error
    // would answer is retried by the provider forever against the same refused address, so the sale is refused with a
    // terminal 422 instead. A config refusal is not this case: it is rethrown unchanged and stays retryable.
    if (!isBuyerAddressRejection(err)) throw err;
    flagForManualReconciliation(
      input.provider,
      input.saleId,
      input.sendKind ?? GLOBAL.delivery.send_kind,
      `the mail provider refused the buyer address (HTTP ${err.statusCode}) on this send; a retry with the same address cannot succeed`,
    );
    throw new DeliveryBlockedError("no_email", input.saleId);
  }
  if (outcome === "no_email") throw new DeliveryBlockedError("no_email", input.saleId);
  if (outcome === "no_release_file") throw new DeliveryBlockedError("no_release_file", input.saleId);
  if (outcome !== "sent") console.warn(`[delivery] sale ${input.saleId}: ${outcome}`);
}

function supabaseDeliveryDb(signal?: AbortSignal): DeliveryDb {
  return {
    async productForAlias(provider, alias) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      // The alias comes from the provider payload: match each column exactly, never splice it into a PostgREST filter string.
      // store_product_id is the internal key every provider carries. paddle_product_id is Paddle's own column, so only
      // a Paddle sale may match it; any other provider matching it would resolve a sale through another provider's ID.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alias);
      const providerColumn = paymentProviderProductIdColumn(provider);
      const columns = [
        "store_product_id",
        ...(providerColumn ? [providerColumn] : []),
        ...(isUuid ? ["id"] : []),
      ];
      for (const column of columns) {
        const { data, error } = await bounded(sb.from("products").select("id, title, release_path").eq(column, alias), signal).maybeSingle();
        if (error) throw new Error(`product lookup failed: ${error.message}`);
        if (!data) continue;
        return { id: data.id as string, title: (data.title as string | null) ?? "your ExpanPress title", releasePath: (data.release_path as string | null) ?? null };
      }
      return null;
    },
    async recordLinkIssued(row) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      const insertPayload: Record<string, unknown> = {
        sale_id: row.saleId,
        product_id: row.productId,
        token_hash: row.tokenHash,
        event_type: "link_issued",
        expires_at: row.expiresAt.toISOString(),
      };
      if (row.linkGeneration !== undefined) {
        insertPayload.link_generation = row.linkGeneration;
      }
      const { error } = await bounded(sb.from("download_events").insert(insertPayload), signal);
      if (!error) return true;
      if (error.code === "23505") return false; // generation collision: a webhook retry is a no-op
      throw new Error(`link insert failed: ${error.message}`);
    },
    async releaseLinkIssued(row) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      const { error } = await bounded(sb
        .from("download_events")
        .delete()
        .eq("sale_id", row.saleId)
        .eq("token_hash", row.tokenHash)
        .eq("event_type", "link_issued"), signal);
      if (error) throw new Error(`link release failed: ${error.message}`);
    },
    async linkStillIssued(row) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      // expires_at NULL never matches the gt filter, so a link with no expiry is refused (fail closed).
      const { data, error } = await bounded(sb
        .from("download_events")
        .select("token_hash")
        .eq("sale_id", row.saleId)
        .eq("token_hash", row.tokenHash)
        .eq("event_type", "link_issued")
        .gt("expires_at", row.now.toISOString())
        .limit(1), signal);
      if (error) throw new Error(`link lookup failed: ${error.message}`);
      return (data ?? []).length > 0;
    },
    async deliveryConfirmed(provider, saleId) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      // Provider-scoped: the same sale ID from another provider must not count as delivered. Confirmations
      // written before details.provider was recorded have no provider, so they never match and the link is re-sent
      // (a duplicate email, which is the safer failure than a buyer with no link).
      const { data, error } = await bounded(sb
        .from("audit_log")
        .select("id")
        .eq("event", DELIVERY_CONFIRMED_EVENT)
        .eq("details->>sale_id", saleId)
        .eq("details->>provider", provider)
        .order("id", { ascending: true })
        .limit(1), signal);
      if (error) throw new Error(`delivery confirmation lookup failed: ${error.message}`);
      if ((data ?? []).length > 0) return true;
      // A sale confirmed before details.provider existed is re-sent, so surface it: the buyer gets a second email.
      const { data: legacy, error: legacyError } = await bounded(sb
        .from("audit_log")
        .select("id")
        .eq("event", DELIVERY_CONFIRMED_EVENT)
        .eq("details->>sale_id", saleId)
        .is("details->>provider", null)
        .limit(1), signal);
      if (legacyError) throw new Error(`delivery confirmation lookup failed: ${legacyError.message}`);
      if ((legacy ?? []).length > 0) {
        console.warn(`[delivery] legacy confirmation without provider for sale ${saleId}; re-sending (a second buyer email)`);
      }
      return false;
    },
    async confirmDelivery(row) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      const { error } = await bounded(sb
        .from("audit_log")
        .insert({
          event: DELIVERY_CONFIRMED_EVENT,
          details: { provider: row.provider, sale_id: row.saleId, token_hash: row.tokenHash },
        }), signal);
      if (error) throw new Error(`delivery confirmation write failed: ${error.message}`);
    },
    ...createDeliverySendsStore(signal),
  };
}
