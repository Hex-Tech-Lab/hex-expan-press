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
 * is rethrown to the webhook, which answers 500 so the provider retries. Its download_events row is
 * released only on a definite provider rejection; an ambiguous failure keeps the link valid. A sale counts as delivered only once its send is confirmed (an audit_log row with
 * event DELIVERY_LINK_SENT, scoped to the provider that issued the sale). A retry mints a fresh monotonic generation link row without destroying prior links,
 * so previously emailed buyer links remain valid and a failed send whose release also failed is never acknowledged without a delivered link.
 */
import { createHash, randomBytes } from "node:crypto";
import { GLOBAL } from "./settings_registry.ts";
import { EmailSendError, sendEmail as realSendEmail } from "./email.ts";
import { DeliveryBlockedError, StaleFenceError } from "./delivery_errors.ts";
import { createDeliverySendsStore, type DeliverySendClaim } from "./delivery_sends_store.ts";
import { getSupabaseAdmin } from "./supabase_admin.ts";

export { StaleFenceError, type DeliverySendClaim };

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** audit_log event written once a link's send is accepted. Its absence marks a sale as not yet delivered. */
const DELIVERY_CONFIRMED_EVENT = "DELIVERY_LINK_SENT";

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
  /** Option A + B: transitions claim to 'sent' only when stored fence <= new fence. */
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
}

export interface DeliveryDeps {
  db: DeliveryDb;
  sendEmail: (input: { to: string; subject: string; html: string; text: string; replyTo?: string }) => Promise<unknown>;
  createShortLink: (targetUrl: string) => Promise<string>;
  origin: string;
  replyTo: string;
  now?: () => Date;
  newToken?: () => string;
  /** Deadline for the mail send, which runs while the sale lock is held. Defaults to payments.http_timeout_ms. */
  timeoutMs?: number;
}

/** Rejects if the promise has not settled within ms. The send may still complete after a timeout. */
function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * A held claim (state 'claimed', never confirmed sent) is never resent: at-most-once, by design. Once it is older than
 * delivery.stuck_claim_after_seconds it is an unconfirmed buyer receipt, so it is logged at error level for an operator.
 */
function noteHeldClaim(provider: string, saleId: string, sendKind: string, claimedAt: string | undefined, deps: DeliveryDeps): void {
  const thresholdMs = GLOBAL.delivery.stuck_claim_after_seconds * 1000;
  if (claimedAt === undefined || !Number.isFinite(thresholdMs)) return;
  const ageMs = (deps.now ? deps.now() : new Date()).getTime() - Date.parse(claimedAt);
  if (!Number.isFinite(ageMs) || ageMs <= thresholdMs) return;
  console.error(
    `[delivery] STUCK CLAIM sale=${saleId} provider=${provider} send_kind=${sendKind} claimed_at=${claimedAt}: ` +
      "no confirmed receipt and not resent (at-most-once). Verify the buyer and resend by hand (listStuckDeliveryClaims).",
  );
}

export type DeliveryOutcome = "sent" | "duplicate" | "no_email" | "no_release_file";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function deliverSale(
  input: {
    provider: string;
    saleId: string;
    productAlias: string;
    buyerEmail?: string;
    sendKind?: string;
    fence?: number;
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
  const product = await deps.db.productForAlias(input.provider, input.productAlias);
  // Fail closed on a product with no release file: a buyer must never get a link to nothing.
  if (!product || !product.releasePath) return "no_release_file";

  // Option A + Option B: claim the single-send row BEFORE creating any download link or sending email
  // (and before deliveryConfirmed so stale-fence workers are rejected even after completion).
  const claim = await deps.db.claimDeliverySend({
    provider: input.provider,
    saleId: input.saleId,
    sendKind,
    fence: input.fence,
  });
  if (claim.outcome !== "claimed") {
    if (claim.outcome === "already_claimed") noteHeldClaim(input.provider, input.saleId, sendKind, claim.claimedAt, deps);
    return "duplicate";
  }

  const now = deps.now ? deps.now() : new Date();
  const token = (deps.newToken ?? newToken)();
  const expiresAt = new Date(now.getTime() + GLOBAL.delivery.link_ttl_days * 24 * 60 * 60 * 1000);
  const hash = tokenHash(token);
  let linkGeneration = nextGeneration(now.getTime());
  let row = { saleId: input.saleId, productId: product.id, tokenHash: hash, expiresAt, linkGeneration };

  let linkInserted = false;
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

    const link = await deps.createShortLink(`${deps.origin}/books/d/${token}`);
    if (input.fence !== undefined) {
      await deps.db.assertSendFence({
        provider: input.provider,
        saleId: input.saleId,
        sendKind,
        fence: input.fence,
      });
    }
    const days = GLOBAL.delivery.link_ttl_days;
    const title = product.title;
    const deadlineMs = deps.timeoutMs ?? GLOBAL.payments.http_timeout_ms;
    sendAttempted = true;
    await withDeadline(deps.sendEmail({
      to: input.buyerEmail,
      subject: `Your download: ${title}`,
      text:
        `Thank you for your purchase of ${title}.\n\n` +
        `Download your copy here (the link is valid for ${days} days):\n${link}\n\n` +
        `Questions? Reply to this email or write to ${deps.replyTo}.\n`,
      html:
        `<p>Thank you for your purchase of <strong>${esc(title)}</strong>.</p>` +
        `<p>Download your copy here (the link is valid for ${days} days):<br><a href="${esc(link)}">${esc(link)}</a></p>` +
        `<p>Questions? Reply to this email or write to ${esc(deps.replyTo)}.</p>`,
      replyTo: deps.replyTo,
    }), deadlineMs, "email send");
  } catch (err) {
    // Release the link and claim ONLY when no email could have been accepted (before sendEmail was
    // called, or on a definite provider 4xx rejection). On an ambiguous failure (timeout, transport
    // error, 5xx), keep BOTH the link row and the 'claimed' row so retries never send a duplicate.
    const definiteNonSend = !sendAttempted || (err instanceof EmailSendError && err.definite);
    if (linkInserted && definiteNonSend) {
      try {
        await deps.db.releaseLinkIssued({ saleId: input.saleId, tokenHash: hash });
      } catch (releaseErr) {
        console.error(`[delivery] sale ${input.saleId}: could not release link row: ${String(releaseErr)}`);
      }
    }
    if (definiteNonSend && !(err instanceof StaleFenceError)) {
      try {
        await deps.db.releaseDeliverySend({
          provider: input.provider,
          saleId: input.saleId,
          sendKind,
          fence: input.fence,
        });
      } catch (releaseClaimErr) {
        console.error(`[delivery] sale ${input.saleId}: could not release send claim: ${String(releaseClaimErr)}`);
      }
    }
    throw err;
  }
  await deps.db.markDeliverySent({
    provider: input.provider,
    saleId: input.saleId,
    sendKind,
    fence: input.fence,
  });
  // Written after sendEmail and delivery_sends transition to 'sent'.
  await deps.db.confirmDelivery({ provider: input.provider, saleId: input.saleId, tokenHash: hash });
  return "sent";
}

/** Dub short link for a target URL. Needs DUB_API_KEY in the environment. */
export async function createDubShortLink(targetUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const key = process.env.DUB_API_KEY;
  if (!key) throw new Error("DUB_API_KEY is missing — cannot create the download short link");
  // Bounded by the webhook-internal budget: this call runs while the sale's idempotency lock is held.
  const res = await fetchImpl("https://api.dub.co/links", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: targetUrl, domain: GLOBAL.delivery.short_domain }),
    signal: AbortSignal.timeout(GLOBAL.payments.http_timeout_ms),
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
export function saleDeliveryConfirmed(provider: string, saleId: string): Promise<boolean> {
  return supabaseDeliveryDb().deliveryConfirmed(provider, saleId);
}

/** Production wiring: Supabase for persistence, Resend for mail, Dub for the short link. */
export function productionDeps(): DeliveryDeps {
  const origin = "https://expanpress.com";
  const replyTo = GLOBAL.email.reply_to;
  return {
    db: supabaseDeliveryDb(),
    sendEmail: realSendEmail,
    createShortLink: (u) => createDubShortLink(u),
    origin,
    replyTo,
  };
}

/**
 * Webhook entry point. A delivery failure is rethrown, so the webhook answers 500 and the provider retries.
 * A sale that cannot be delivered (no buyer email, no release file) also throws: the buyer is owed a link, so
 * the webhook must not acknowledge the sale as delivered.
 */
export async function deliverSaleForWebhook(
  input: {
    provider: string;
    saleId: string;
    productAlias: string;
    buyerEmail?: string;
    sendKind?: string;
    fence?: number;
  },
  deps: DeliveryDeps = productionDeps(),
): Promise<void> {
  const outcome = await deliverSale(input, deps);
  if (outcome === "no_email") throw new DeliveryBlockedError("no_email", input.saleId);
  if (outcome === "no_release_file") throw new DeliveryBlockedError("no_release_file", input.saleId);
  if (outcome !== "sent") console.warn(`[delivery] sale ${input.saleId}: ${outcome}`);
}

function supabaseDeliveryDb(): DeliveryDb {
  return {
    async productForAlias(provider, alias) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      // The alias comes from the provider payload: match each column exactly, never splice it into a PostgREST filter string.
      // store_product_id is the internal key every provider carries. paddle_product_id is Paddle's own column, so only
      // a Paddle sale may match it; any other provider matching it would resolve a sale through another provider's ID.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alias);
      const columns = [
        "store_product_id",
        ...(provider === "paddle" ? ["paddle_product_id"] : []),
        ...(isUuid ? ["id"] : []),
      ];
      for (const column of columns) {
        const { data, error } = await sb.from("products").select("id, title, release_path").eq(column, alias).maybeSingle();
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
      const { error } = await sb.from("download_events").insert(insertPayload);
      if (!error) return true;
      if (error.code === "23505") return false; // generation collision: a webhook retry is a no-op
      throw new Error(`link insert failed: ${error.message}`);
    },
    async releaseLinkIssued(row) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      const { error } = await sb
        .from("download_events")
        .delete()
        .eq("sale_id", row.saleId)
        .eq("token_hash", row.tokenHash)
        .eq("event_type", "link_issued");
      if (error) throw new Error(`link release failed: ${error.message}`);
    },
    async deliveryConfirmed(provider, saleId) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      // Provider-scoped: the same sale ID from another provider must not count as delivered. Confirmations
      // written before details.provider was recorded have no provider, so they never match and the link is re-sent
      // (a duplicate email, which is the safer failure than a buyer with no link).
      const { data, error } = await sb
        .from("audit_log")
        .select("id")
        .eq("event", DELIVERY_CONFIRMED_EVENT)
        .eq("details->>sale_id", saleId)
        .eq("details->>provider", provider)
        .order("id", { ascending: true })
        .limit(1);
      if (error) throw new Error(`delivery confirmation lookup failed: ${error.message}`);
      if ((data ?? []).length > 0) return true;
      // A sale confirmed before details.provider existed is re-sent, so surface it: the buyer gets a second email.
      const { data: legacy, error: legacyError } = await sb
        .from("audit_log")
        .select("id")
        .eq("event", DELIVERY_CONFIRMED_EVENT)
        .eq("details->>sale_id", saleId)
        .is("details->>provider", null)
        .limit(1);
      if (legacyError) throw new Error(`delivery confirmation lookup failed: ${legacyError.message}`);
      if ((legacy ?? []).length > 0) {
        console.warn(`[delivery] legacy confirmation without provider for sale ${saleId}; re-sending (a second buyer email)`);
      }
      return false;
    },
    async confirmDelivery(row) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      const { error } = await sb
        .from("audit_log")
        .insert({
          event: DELIVERY_CONFIRMED_EVENT,
          details: { provider: row.provider, sale_id: row.saleId, token_hash: row.tokenHash },
        });
      if (error) throw new Error(`delivery confirmation write failed: ${error.message}`);
    },
    ...createDeliverySendsStore(),
  };
}
