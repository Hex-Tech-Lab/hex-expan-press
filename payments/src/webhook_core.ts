import { isRegisteredPaymentProvider, paymentProviderSetting, isMoneyPath, GLOBAL } from "./settings_registry.ts";
import { getSupabaseAdmin } from "./supabase_admin.ts";
import { expanRedis, isRedisRestConfigured } from "../../src/infrastructure/redis/redis.client.ts";
import type { ProviderName } from "./provider.ts";

const FALLBACK_SECRET_ENV: Record<ProviderName, string> = {
  lemonsqueezy: "LEMONSQUEEZY_WEBHOOK_SECRET",
  payhip: "PAYHIP_WEBHOOK_SECRET",
  paddle: "PADDLE_WEBHOOK_SECRET",
  polar: "POLAR_WEBHOOK_SECRET",
  fungies: "FUNGIES_WEBHOOK_SECRET",
  fastspring: "FASTSPRING_WEBHOOK_SECRET",
};

export function getSecret(provider: ProviderName): string | undefined {
  const envName = paymentProviderSetting(provider)?.secret_env ?? FALLBACK_SECRET_ENV[provider];
  return envName ? process.env[envName] : undefined;
}

/**
 * Resolves ONE product from the database by any of its provider-facing alias
 * ids (Sprint 15 heritage eradication — replaces the file-backed
 * loadProductIndex scan over payments/config.*.json; the DB is the single
 * source of truth for commercial state).
 *
 * Alias arms mirror the legacy index keys: store product id, paddle product
 * id, polar sandbox/live ids, composite slug, and the row uuid (id arm only
 * when the alias IS a uuid — a non-uuid value in an id.eq arm makes PostgREST
 * reject the whole filter, the same cast trap fixed in the checkout route on
 * PR #85).
 *
 * The bare portal slug (products.slug) is deliberately NOT an arm: it is
 * unique only per creator (unique (creator_id, slug) in the portal
 * migration), so a bare slug can match several creators' products and
 * .maybeSingle() would 500-loop a valid provider delivery. The nested
 * site_slug (<handle>/<product_slug>) is not an arm either: it can never
 * match a provider-id charset (it contains '/'), provider payloads never
 * carry site slugs, and the checkout route — the slug-resolving surface —
 * rejects '/' in its product parameter too. Provider payloads carry provider
 * ids (store/paddle/polar ids), never URL slugs.
 *
 * Injection guard: the alias arrives from provider webhook payloads. The
 * PostgREST .or() grammar treats commas/parens as syntax, and '.'/':' are
 * reserved characters that must be double-quoted inside filter values — an
 * unvalidated alias could misparse the filter (400) or append attacker-chosen
 * conditions. The charset mirrors the checkout route's SAFE_PRODUCT_RE
 * ([A-Za-z0-9_-]); anything else resolves to null (the caller then throws
 * "Unknown product_id" → 500 → provider retries).
 *
 * Fail closed: an unconfigured Supabase admin client throws (never returns an
 * empty success) — the provider will redeliver once the DB is reachable.
 */
const PRODUCT_ALIAS_RE = /^[A-Za-z0-9_-]{1,120}$/;

export interface ResolvedProduct {
  /** Provider custom_data key (products.store_product_id). */
  productId: string;
  /** Creator handle (creators.handle) — the ledger's creator_id namespace. */
  creatorHandle: string;
  currency: string;
}

export async function resolveProductByAlias(alias: string): Promise<ResolvedProduct | null> {
  if (typeof alias !== "string" || !PRODUCT_ALIAS_RE.test(alias)) return null;
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("webhook: Supabase admin client unavailable — product resolution cannot run (fail closed)");
  }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alias);
  const conditions = [
    `store_product_id.eq.${alias}`,
    `paddle_product_id.eq.${alias}`,
    `polar_product_id_sandbox.eq.${alias}`,
    `polar_product_id_live.eq.${alias}`,
    `composite_slug.eq.${alias}`,
    ...(isUuid ? [`id.eq.${alias}`] : []),
  ];
  const { data, error } = await supabase
    .from("products")
    .select("store_product_id, currency, provider, creators(handle)")
    .or(conditions.join(","))
    .maybeSingle();
  if (error) {
    throw new Error(`webhook: product lookup failed for '${alias}': ${error.message}`);
  }
  if (!data) return null;
  const row = data as {
    store_product_id: string | null;
    currency: string;
    provider: string | null;
    creators?: { handle?: string } | null;
  };
  // Parity with the legacy index: products on unregistered providers never sold.
  if (!row.store_product_id || !row.creators?.handle || !isRegisteredPaymentProvider(row.provider ?? "")) {
    return null;
  }
  return { productId: row.store_product_id, creatorHandle: row.creators.handle, currency: row.currency };
}

// Webhook idempotency lock: findSale/appendSale (and the refund equivalent) are a plain
// read-then-append over a JSONL file — a TOCTOU race window under concurrent deliveries
// (payment providers retry aggressively; serverless invocations run concurrently). Two
// deliveries for the same sale_id could both pass the file-based duplicate check before
// either has appended, producing a double creator payout. Upstash SETNX closes that window
// with an atomic distributed lock. Redis is optional infra (local/test runs without it) —
// when unconfigured, behavior is unchanged (file-based check only, as before).
const WEBHOOK_LOCK_TTL_SECONDS = GLOBAL.payments.webhook_lock_ttl_seconds; // bounds a stuck lock if a process dies mid-write (settings registry)

function isRedisConfigured(): boolean {
  return isRedisRestConfigured();
}

/**
 * Thrown when another delivery holds the idempotency lock. The holder may still
 * FAIL, so this must never be acknowledged as success: callers either confirm the
 * record is durably persisted (→ 200) or answer 503 so the provider retries.
 */
export class WebhookInFlightError extends Error {
  constructor(readonly lockKey: string) {
    super(`webhook in flight: lock ${lockKey} is held by another delivery`);
    this.name = "WebhookInFlightError";
  }
}

export async function withIdempotencyLock(
  lockKey: string,
  fn: () => Promise<{ status: number; payload: Record<string, unknown> }>,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!isRedisConfigured()) {
    // Production must never process money without the distributed lock: an
    // unconfigured store throws (→ 500, provider retries) instead of silently
    // running unlocked. Elsewhere the lock stays optional infra.
    if (isMoneyPath()) {
      throw new Error("webhook idempotency lock unavailable: Redis is not configured in a money-path runtime (production/previews/Lambda) (set UPSTASH_REDIS_REST_* or KV_REST_API_*)");
    }
    return fn();
  }

  const acquired = await expanRedis.setnx(lockKey, "1", WEBHOOK_LOCK_TTL_SECONDS);
  if (!acquired) throw new WebhookInFlightError(lockKey);

  try {
    const result = await fn();
    // Nothing was actually written (true duplicate, unknown product, terms lookup failure,
    // etc.) — free the slot immediately so a corrected retry isn't blocked for the full TTL.
    if (result.payload.recorded !== true) {
      await expanRedis.del(lockKey);
    }
    return result;
  } catch (err) {
    console.error(`[webhook] locked fn threw (lock=${lockKey}) — releasing lock:`, err);
    await expanRedis.del(lockKey);
    throw err;
  }
}

