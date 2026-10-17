/**
 * Buyer delivery (launch blocker, item 3). After a sale is recorded:
 *   1. mint a random download token; store only its sha256 (download_events, once per sale)
 *   2. wrap {origin}/d/{token} in a Dub short link (go.expanpress.com)
 *   3. email the buyer the link via Resend
 * GET /d/{token} then validates the hash and expiry, logs download_completed, and 302s to a
 * 300-second signed URL for the release file. Only the server-side log makes the served-download
 * claim; it records that a signed URL was issued, not that the browser finished the transfer.
 *
 * Failure policy: delivery never fails the webhook. The ledger write is the money record and
 * stays authoritative. If the link cannot be shortened or mailed, its download_events row is
 * released so a webhook retry can issue and send a fresh link.
 */
import { createHash, randomBytes } from "node:crypto";
import { GLOBAL } from "./settings_registry.ts";
import { sendEmail as realSendEmail } from "./email.ts";
import { getSupabaseAdmin } from "./supabase_admin.ts";

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
export const newToken = (): string => randomBytes(32).toString("base64url");

export interface DeliveryProduct {
  id: string;
  title: string;
  releasePath: string | null;
}

/** The persistence the delivery flow needs. Injected so the flow is testable without a database. */
export interface DeliveryDb {
  productForAlias(alias: string): Promise<DeliveryProduct | null>;
  /** Inserts the link_issued row. Returns false when a row for this sale already exists. */
  recordLinkIssued(row: { saleId: string; productId: string; tokenHash: string; expiresAt: Date }): Promise<boolean>;
  /** Removes the link_issued row for this sale and token, so a later attempt can issue again. */
  releaseLinkIssued(row: { saleId: string; tokenHash: string }): Promise<void>;
}

export interface DeliveryDeps {
  db: DeliveryDb;
  sendEmail: (input: { to: string; subject: string; html: string; text: string; replyTo?: string }) => Promise<unknown>;
  createShortLink: (targetUrl: string) => Promise<string>;
  origin: string;
  replyTo: string;
  now?: () => Date;
  newToken?: () => string;
}

export type DeliveryOutcome = "sent" | "duplicate" | "no_email" | "no_release_file";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function deliverSale(
  input: { saleId: string; productAlias: string; buyerEmail?: string },
  deps: DeliveryDeps,
): Promise<DeliveryOutcome> {
  if (!input.buyerEmail) return "no_email";
  const product = await deps.db.productForAlias(input.productAlias);
  // Fail closed on a product with no release file: a buyer must never get a link to nothing.
  if (!product || !product.releasePath) return "no_release_file";

  const now = deps.now ? deps.now() : new Date();
  const token = (deps.newToken ?? newToken)();
  const expiresAt = new Date(now.getTime() + GLOBAL.delivery.link_ttl_days * 24 * 60 * 60 * 1000);
  const hash = tokenHash(token);
  const issued = await deps.db.recordLinkIssued({
    saleId: input.saleId,
    productId: product.id,
    tokenHash: hash,
    expiresAt,
  });
  if (!issued) return "duplicate";

  try {
    const link = await deps.createShortLink(`${deps.origin}/d/${token}`);
    const days = GLOBAL.delivery.link_ttl_days;
    const title = product.title;
    await deps.sendEmail({
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
    });
  } catch (err) {
    // Free the sale's one link slot so a webhook retry can deliver. The original error still propagates.
    try {
      await deps.db.releaseLinkIssued({ saleId: input.saleId, tokenHash: hash });
    } catch (releaseErr) {
      console.error(`[delivery] sale ${input.saleId}: could not release link row: ${(releaseErr as Error).message}`);
    }
    throw err;
  }
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

/** Webhook entry point. Never throws: a delivery failure is logged and the webhook still succeeds. */
export async function deliverSaleSafely(input: { saleId: string; productAlias: string; buyerEmail?: string }): Promise<void> {
  try {
    const outcome = await deliverSale(input, productionDeps());
    if (outcome !== "sent") console.warn(`[delivery] sale ${input.saleId}: ${outcome}`);
  } catch (err) {
    console.error(`[delivery] sale ${input.saleId} not delivered: ${(err as Error).message}`);
  }
}

function supabaseDeliveryDb(): DeliveryDb {
  return {
    async productForAlias(alias) {
      const sb = await getSupabaseAdmin();
      if (!sb) throw new Error("Supabase admin client unavailable");
      // The alias comes from the provider payload: match each column exactly, never splice it into a PostgREST filter string.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alias);
      const columns = ["store_product_id", "paddle_product_id", ...(isUuid ? ["id"] : [])];
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
      const { error } = await sb.from("download_events").insert({
        sale_id: row.saleId,
        product_id: row.productId,
        token_hash: row.tokenHash,
        event_type: "link_issued",
        expires_at: row.expiresAt.toISOString(),
      });
      if (!error) return true;
      if (error.code === "23505") return false; // one link per sale: a webhook retry is a no-op
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
  };
}
