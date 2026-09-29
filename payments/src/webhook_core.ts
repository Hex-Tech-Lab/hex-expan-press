import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRefund, appendSale, findRefund, findSale, SALES_FILE } from "./ledger.ts";
import { isRegisteredPaymentProvider, paymentProviderSetting } from "./settings_registry.ts";
import { loadConfig, type ProductConfig } from "./settings.ts";
import { computeSplit } from "./split.ts";
import { effectiveCreatorSplitPct } from "./terms.ts";
import { expanRedis, isRedisRestConfigured } from "../../src/infrastructure/redis/redis.client.ts";
import { lemonsqueezyProvider } from "./providers/lemonsqueezy.ts";
import { payhipProvider } from "./providers/payhip.ts";
import { paddleProvider } from "./providers/paddle.ts";
import { polarProvider } from "./providers/polar.ts";
import { fungiesProvider } from "./providers/fungies.ts";
import { fastspringProvider } from "./providers/fastspring.ts";
import type { IncomingHttpHeaders } from "node:http";
import type { CheckoutProvider, ProviderName, RefundEvent, SaleEvent } from "./provider.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ADAPTERS: Record<ProviderName, CheckoutProvider> = {
  lemonsqueezy: lemonsqueezyProvider,
  payhip: payhipProvider,
  paddle: paddleProvider,
  polar: polarProvider,
  fungies: fungiesProvider,
  fastspring: fastspringProvider,
};

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
 * Loads every active product config into a lookup index keyed by internal
 * product id, provider product ids (sandbox/live), and site slug. Config
 * directory resolution order: PAYMENTS_CONFIG_DIR override, module-relative
 * payments/, cwd-relative payments/ — first directory that actually contains
 * product config files wins. config.example.json is never indexed.
 */
export function loadProductIndex(): Map<string, ProductConfig> {
  const idx = new Map<string, ProductConfig>();
  // PAYMENTS_CONFIG_DIR indirection exists for the Next.js/Turbopack build:
  // its static file tracer evaluates path.join(HERE, "..") to the payments/
  // DIRECTORY and hard-fails hashing a directory asset ("Invalid file type
  // Directory"). With the env-gated branch the tracer cannot statically
  // resolve the path and skips it; the config files are instead bundled via
  // web/next.config.ts outputFileTracingIncludes for the webhook route.
  // Candidate order (first dir containing config.*.json wins):
  //   1. PAYMENTS_CONFIG_DIR env override (deployment pin)
  //   2. module-relative payments/ (classic standalone/serverless layout)
  //   3. process.cwd()/payments (scripts run from repo root)
  //   4. process.cwd()/../payments (next start runs with cwd=web/)
  const candidates = [
    process.env.PAYMENTS_CONFIG_DIR,
    path.join(HERE, ".."),
    path.join(process.cwd(), "payments"),
    path.join(process.cwd(), "..", "payments"),
  ].filter((d): d is string => typeof d === "string");
  // Same predicate for directory SELECTION and file LOADING: config.example.json
  // must not win the selection (a directory holding only the example file would
  // otherwise be chosen, then skipped, leaving an empty product index).
  const isProductConfigFile = (fileName: string): boolean =>
    fileName.startsWith("config.") && fileName.endsWith(".json") && fileName !== "config.example.json";
  const paymentsDir =
    candidates.find((dir) => {
      try {
        return readdirSync(dir).some(isProductConfigFile);
      } catch (probeErr) {
        console.error(`[webhook] candidate config dir probe failed: ${probeErr instanceof Error ? probeErr.message : probeErr}`);
        return false; // unreadable candidate dir — try next
      }
    }) ?? candidates[0];
  try {
    const files = readdirSync(paymentsDir).filter(isProductConfigFile);
    for (const configFile of files) {
      try {
        const c = loadConfig(path.join(paymentsDir, configFile));
        idx.set(c.product_id, c);
        // Aliases: webhook events may arrive keyed by provider product id, internal id, or site slug
        const raw = JSON.parse(readFileSync(path.join(paymentsDir, configFile), "utf8")) as Record<string, unknown>;
        if (typeof raw.product_internal_id === "string") idx.set(raw.product_internal_id, c);
        if (typeof raw.polar_product_id_sandbox === "string") idx.set(raw.polar_product_id_sandbox, c);
        if (typeof raw.polar_product_id_live === "string") idx.set(raw.polar_product_id_live, c);
        if (typeof raw.site_slug === "string") idx.set(raw.site_slug, c);
      } catch (err) {
        console.error(`[webhook] failed to load ${configFile}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.error(`[webhook] readdirSync failed: ${(err as Error).message}`);
  }

  for (const [pid, c] of idx) {
    if (!isRegisteredPaymentProvider(c.provider)) {
      console.error(`[webhook] product "${pid}" dropped: provider "${c.provider}" is not registered in providers.json`);
      idx.delete(pid);
    }
  }
  return idx;
}

// Webhook idempotency lock: findSale/appendSale (and the refund equivalent) are a plain
// read-then-append over a JSONL file — a TOCTOU race window under concurrent deliveries
// (payment providers retry aggressively; serverless invocations run concurrently). Two
// deliveries for the same sale_id could both pass the file-based duplicate check before
// either has appended, producing a double creator payout. Upstash SETNX closes that window
// with an atomic distributed lock. Redis is optional infra (local/test runs without it) —
// when unconfigured, behavior is unchanged (file-based check only, as before).
const WEBHOOK_LOCK_TTL_SECONDS = 300; // bounds a stuck lock if a process dies mid-write

function isRedisConfigured(): boolean {
  return isRedisRestConfigured();
}

/** Strictly Vercel production — previews/local/tests keep the lock optional. */
function isProduction(): boolean {
  return process.env.VERCEL_ENV === "production";
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
    if (isProduction()) {
      throw new Error("webhook idempotency lock unavailable: Redis is not configured in production (set UPSTASH_REDIS_REST_* or KV_REST_API_*)");
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

/** Legacy-handler shape for a held lock: retryable, never a success ack. */
function inFlightResponse(err: unknown): { status: number; payload: Record<string, unknown> } {
  if (err instanceof WebhookInFlightError) {
    return { status: 503, payload: { ok: false, retryable: true, reason: "in-flight" } };
  }
  throw err;
}

export async function recordRefund(refundEvent: RefundEvent): Promise<{ status: number; payload: Record<string, unknown> }> {
  return withIdempotencyLock(
    `lock:refund:${refundEvent.provider}:${refundEvent.sale_id}`,
    async () => {
      const existingRefund = findRefund(refundEvent.provider, refundEvent.sale_id);
      if (existingRefund) {
        return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", event_type: "refund", sale_id: refundEvent.sale_id } };
      }
      try {
        const record = await appendRefund({ provider: refundEvent.provider, sale_id: refundEvent.sale_id, ts: refundEvent.ts });
        return { status: 200, payload: { ok: true, recorded: true, event_type: "refund", sale_id: record.sale_id, refund_amount_usd: record.amount_usd } };
      } catch (err) {
        console.error(`[webhook] refund append failed (provider=${refundEvent.provider} sale=${refundEvent.sale_id}):`, err);
        return { status: 500, payload: { ok: false, error: (err as Error).message } }; // infra failure → provider retries (4xx = never retried)
      }
    },
  ).catch(inFlightResponse);
}

export async function recordSale(result: SaleEvent): Promise<{ status: number; payload: Record<string, unknown> }> {
  return withIdempotencyLock(
    `lock:sale:${result.provider}:${result.sale_id}`,
    async () => {
      const existing = findSale(result.provider, result.sale_id);
      if (existing) {
        return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", sale_id: result.sale_id } };
      }

      const cfg = loadProductIndex().get(result.product_id);
      if (!cfg) {
        return { status: 422, payload: { ok: false, error: `unknown product_id: ${result.product_id} (no product config)` } };
      }

      let creatorSplitPct: number;
      try {
        const pct = effectiveCreatorSplitPct(cfg.creator_id, cfg.product_id, result.ts);
        if (pct === null) {
          return { status: 500, payload: { ok: false, error: `no effective creator terms for creator=${cfg.creator_id} product=${cfg.product_id}` } };
        }
        creatorSplitPct = pct;
      } catch (err) {
        console.error(`[webhook] creator terms lookup failed (creator=${cfg.creator_id} product=${cfg.product_id}):`, err);
        return { status: 500, payload: { ok: false, error: `creator terms lookup failed: ${(err as Error).message}` } };
      }

      const split = computeSplit(result.amount_usd, creatorSplitPct);

      try {
        const record = await appendSale({
          ...result,
          creator_id: cfg.creator_id,
          creator_split_pct: creatorSplitPct,
          creator_split_usd: split.creator_split_usd,
          our_split_usd: split.our_split_usd,
          currency: cfg.currency,
        });
        return {
          status: 200,
          payload: {
            ok: true,
            recorded: true,
            sale_id: record.sale_id,
            amount_usd: record.amount_usd,
            creator_split_usd: record.creator_split_usd,
            our_split_usd: record.our_split_usd,
          },
        };
      } catch (err) {
        console.error(`[webhook] sale append failed (provider=${result.provider} sale=${result.sale_id}):`, err);
        return { status: 500, payload: { ok: false, error: (err as Error).message } }; // infra failure → provider retries (4xx = never retried)
      }
    },
  ).catch(inFlightResponse);
}

export async function handleWebhookPayload(
  providerName: string,
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!isRegisteredPaymentProvider(providerName)) {
    return { status: 404, payload: { ok: false, error: `unknown provider: ${providerName}` } };
  }

  const adapter = ADAPTERS[providerName as ProviderName];
  if (!adapter) {
    return { status: 404, payload: { ok: false, error: `unsupported provider: ${providerName}` } };
  }

  const secret = getSecret(providerName as ProviderName);
  const parsed = adapter.parseWebhook(headers, rawBody, secret);

  if (!parsed.ok) {
    return { status: parsed.status, payload: { ok: false, error: parsed.error } };
  }

  if ("sale" in parsed) {
    return recordSale(parsed.sale);
  } else if ("refund" in parsed) {
    return recordRefund(parsed.refund);
  } else if ("batch" in parsed) {
    const results = [];
    for (const item of parsed.batch) {
      if ("sale" in item) results.push(await recordSale(item.sale));
      else if ("refund" in item) results.push(await recordRefund(item.refund));
    }
    return { status: 200, payload: { ok: true, batch_count: results.length, results } };
  }

  return { status: 400, payload: { ok: false, error: "unhandled event shape" } };
}
