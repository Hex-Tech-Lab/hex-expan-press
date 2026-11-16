import { randomUUID } from "node:crypto";
import { isEnabledPaymentProvider, paymentProviderSetting, isMoneyPath, GLOBAL } from "./settings_registry.ts";
import { getSupabaseAdmin } from "./supabase_admin.ts";
import { expanRedis, isRedisRestConfigured } from "../../src/infrastructure/redis/redis.client.ts";
import { WebhookValidationError } from "../../src/domain/webhook/webhook_errors.ts";
import type { ProviderName } from "./provider.ts";

// Polar is not routable (PR 102), so it has no fallback secret. Partial because "polar" stays in ProviderName for historical rows.
const FALLBACK_SECRET_ENV: Partial<Record<ProviderName, string>> = {
  lemonsqueezy: "LEMONSQUEEZY_WEBHOOK_SECRET",
  payhip: "PAYHIP_WEBHOOK_SECRET",
  paddle: "PADDLE_WEBHOOK_SECRET",
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
 * Alias arms: store product id (store_product_id), paddle product id (Paddle
 * sales only), polar sandbox/live ids (polar_product_id_sandbox,
 * polar_product_id_live), and the row uuid (id arm only when the alias IS a
 * uuid — a non-uuid value in an id.eq arm makes PostgREST reject the whole
 * filter, the same cast trap fixed in the checkout route on PR #85), all scoped
 * to provider = providerName. No derived identifier is an arm: a provider
 * product reference resolves only through those stored product-id columns or
 * the product UUID.
 *
 * The bare portal slug (products.slug) is deliberately NOT an arm: it is
 * unique only per creator (unique (creator_id, slug) in the portal
 * migration), so a bare slug can match several creators' products and
 * .maybeSingle() would 500-loop a valid provider delivery. Provider payloads
 * carry provider ids (store/paddle/polar ids), never URL slugs.
 *
 * Injection guard: the alias arrives from provider webhook payloads. The
 * PostgREST .or() grammar treats commas/parens as syntax, and '.'/':' are
 * reserved characters that must be double-quoted inside filter values — an
 * unvalidated alias could misparse the filter (400) or append attacker-chosen
 * conditions. The charset mirrors the checkout route's SAFE_PRODUCT_RE
 * ([A-Za-z0-9_-]); anything else resolves to null (the caller then throws
 * "Unknown product_id" → 422, a terminal rejection: the sale is quarantined, not retried). A row that exists but
 * cannot sell yet throws, so the provider retries.
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
  /** products.checkout_mode ('live' | 'sandbox' | 'gated' | 'paddle' | null). Only 'live' and 'sandbox' can match a sale's mode. */
  checkoutMode: string | null;
}

/**
 * Resolves a sale's product alias. paddle_product_id is Paddle's own column, so only a Paddle sale may match it.
 * Any other provider matching it would book a sale that delivery then cannot deliver (the delivery lookup applies the same rule).
 */
export async function resolveProductByAlias(alias: string, providerName: string): Promise<ResolvedProduct | null> {
  if (typeof alias !== "string" || !PRODUCT_ALIAS_RE.test(alias)) return null;
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("webhook: Supabase admin client unavailable — product resolution cannot run (fail closed)");
  }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alias);
  const conditions = [
    `store_product_id.eq.${alias}`,
    ...(providerName === "paddle" ? [`paddle_product_id.eq.${alias}`] : []),
    `polar_product_id_sandbox.eq.${alias}`,
    `polar_product_id_live.eq.${alias}`,
    ...(isUuid ? [`id.eq.${alias}`] : []),
  ];
  const { data, error } = await supabase
    .from("products")
    .select("store_product_id, currency, provider, checkout_mode, creators(handle)")
    .or(conditions.join(","))
    .eq("provider", providerName)
    .maybeSingle();
  if (error) {
    throw new Error(`webhook: product lookup failed for '${alias}': ${error.message}`);
  }
  if (!data) return null;
  const row = data as {
    store_product_id: string | null;
    currency: string;
    provider: string | null;
    checkout_mode: string | null;
    creators?: { handle?: string } | null;
  };
  // F-18: the product must belong to the provider that sent the sale. Another provider's product row is no match, so
  // the caller answers its terminal "unknown product" (422). Checked before the retryable branch below: a foreign row
  // must never loop on 503.
  if (row.provider !== providerName) return null;
  // The row exists but cannot sell yet: its provider is not enabled, or it lacks a store id or creator handle.
  // That is retryable on purpose. A re-enabled provider or a repaired row makes the next delivery succeed, and
  // the sale stays unrecorded until then. Returning null here would quarantine it permanently (422).
  if (!row.store_product_id || !row.creators?.handle || !isEnabledPaymentProvider(providerName)) {
    // 503: the handler audits it and sends Retry-After, so each attempt leaves a row and the provider retries.
    throw new WebhookValidationError(`product '${alias}' exists but cannot sell yet (provider ${providerName} not enabled, or product incomplete)`, 503);
  }
  return { productId: row.store_product_id, creatorHandle: row.creators.handle, currency: row.currency, checkoutMode: row.checkout_mode };
}

// Webhook idempotency lock: findSale/appendSale (and the refund equivalent) are a plain
// read-then-append over a JSONL file — a TOCTOU race window under concurrent deliveries
// (payment providers retry aggressively; serverless invocations run concurrently). Two
// deliveries for the same sale_id could both pass the file-based duplicate check before
// either has appended, producing a double creator payout. Upstash SETNX + a monotonic
// companion INCR fencing token close that window and reject stale lock holders after TTL expiry.
function lockSettings(): { ttlSeconds: number; fenceSuffix: string; fenceTtlSeconds: number } {
  const p = GLOBAL.payments;
  const ttlSeconds = p.webhook_lock_ttl_seconds;
  const fenceSuffix = p.webhook_lock_fence_suffix;
  const fenceTtlSeconds = p.webhook_lock_fence_ttl_seconds;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("webhook idempotency lock: invalid payments.webhook_lock_ttl_seconds in settings registry");
  }
  if (typeof fenceSuffix !== "string" || fenceSuffix.trim() === "") {
    throw new Error("webhook idempotency lock: missing payments.webhook_lock_fence_suffix in settings registry");
  }
  if (!Number.isSafeInteger(fenceTtlSeconds) || fenceTtlSeconds <= 0) {
    throw new Error("webhook idempotency lock: invalid payments.webhook_lock_fence_ttl_seconds in settings registry");
  }
  return { ttlSeconds, fenceSuffix, fenceTtlSeconds };
}

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

/**
 * Releases the lock only if this call still owns it (compare-and-delete on the random token stored at acquire). An
 * unowned DEL could remove a lock that expired and was re-acquired by another delivery. A failure is logged and never
 * replaces the caller's error; the lock TTL clears a lock that stays held.
 */
async function releaseLock(lockKey: string, token: string): Promise<void> {
  try {
    await expanRedis.compareAndDel(lockKey, token);
  } catch (delErr) {
    console.error(`[webhook] lock release failed (lock=${lockKey}); the TTL will clear it:`, delErr);
  }
}

export async function withIdempotencyLock(
  lockKey: string,
  fn: (fenceToken?: number) => Promise<{ status: number; payload: Record<string, unknown> }>,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!isRedisConfigured()) {
    // Production must never process money without the distributed lock: an
    // unconfigured store throws (→ 500, provider retries) instead of silently
    // running unlocked. Elsewhere the lock stays optional infra.
    if (isMoneyPath()) {
      throw new Error("webhook idempotency lock unavailable: Redis is not configured in a money-path runtime (production/previews/Lambda) (set UPSTASH_REDIS_REST_* or KV_REST_API_*)");
    }
    return fn(undefined);
  }

  const { ttlSeconds, fenceSuffix, fenceTtlSeconds } = lockSettings();
  // The stored value is this call's random owner token, so release can prove ownership (see releaseLock).
  const token = randomUUID();
  const acquired = await expanRedis.setnx(lockKey, token, ttlSeconds);
  if (!acquired) throw new WebhookInFlightError(lockKey);

  let stillOwned = true;
  try {
    const fenceKey = `${lockKey}${fenceSuffix}`;
    const fenceToken = await expanRedis.incr(fenceKey);
    if (typeof fenceToken !== "number" || !Number.isSafeInteger(fenceToken) || fenceToken < 1) {
      throw new Error(`webhook idempotency lock: invalid fencing token from Redis INCR on ${fenceKey}`);
    }
    if (typeof expanRedis.expire === "function") {
      try {
        await expanRedis.expire(fenceKey, fenceTtlSeconds);
      } catch (expErr) {
        console.warn(`[webhook] fence TTL refresh failed (key=${fenceKey}):`, expErr);
      }
    }
    // Verify we still hold the lock after INCR so a process that stalled between SETNX and INCR
    // past lock TTL cannot carry a larger fence token than the worker that superseded it.
    if (typeof expanRedis.get === "function") {
      const owner = await expanRedis.get(lockKey);
      if (owner !== undefined && owner !== token) {
        stillOwned = false;
        throw new WebhookInFlightError(lockKey);
      }
    }

    const result = await fn(fenceToken);
    // Nothing was actually written (true duplicate, unknown product, terms lookup failure,
    // etc.) — free the slot immediately so a corrected retry isn't blocked for the full TTL.
    if (result.payload.recorded !== true) {
      await releaseLock(lockKey, token);
    }
    return result;
  } catch (err) {
    console.error(`[webhook] locked fn threw (lock=${lockKey}) — releasing lock:`, err);
    // The caller's error must reach the handler unchanged. A failed release is logged; the lock TTL bounds it.
    if (stillOwned) {
      await releaseLock(lockKey, token);
    }
    throw err;
  }
}

