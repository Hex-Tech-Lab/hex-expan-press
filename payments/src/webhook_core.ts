import type { IncomingHttpHeaders } from "node:http";
import type { CheckoutProvider, ProviderName, RefundEvent, SaleEvent } from "./provider.ts";
import { appendRefund, appendSale, findRefund, findSale, SALES_FILE } from "./ledger.ts";
import { isRegisteredPaymentProvider, paymentProviderSetting } from "./settings_registry.ts";
import { loadConfig, type ProductConfig } from "./settings.ts";
import { computeSplit } from "./split.ts";
import { effectiveCreatorSplitPct } from "./terms.ts";
import { expanRedis } from "../../src/infrastructure/redis/redis.client.ts";
import { lemonsqueezyProvider } from "./providers/lemonsqueezy.ts";
import { payhipProvider } from "./providers/payhip.ts";
import { paddleProvider } from "./providers/paddle.ts";
import { polarProvider } from "./providers/polar.ts";
import { fungiesProvider } from "./providers/fungies.ts";
import { fastspringProvider } from "./providers/fastspring.ts";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function loadProductIndex(): Map<string, ProductConfig> {
  const idx = new Map<string, ProductConfig>();
  const paymentsDir = path.join(HERE, "..");
  try {
    const files = readdirSync(paymentsDir).filter((f) => f.startsWith("config.") && f.endsWith(".json"));
    for (const f of files) {
      if (f === "config.example.json") continue;
      try {
        const c = loadConfig(path.join(paymentsDir, f));
        idx.set(c.product_id, c);
      } catch (err) {
        console.error(`[webhook] failed to load ${f}: ${(err as Error).message}`);
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
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function withIdempotencyLock(
  lockKey: string,
  duplicateResponse: { status: number; payload: Record<string, unknown> },
  fn: () => Promise<{ status: number; payload: Record<string, unknown> }>,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!isRedisConfigured()) return fn();

  const acquired = await expanRedis.setnx(lockKey, "1", WEBHOOK_LOCK_TTL_SECONDS);
  if (!acquired) return duplicateResponse;

  try {
    const result = await fn();
    // Nothing was actually written (true duplicate, unknown product, terms lookup failure,
    // etc.) — free the slot immediately so a corrected retry isn't blocked for the full TTL.
    if (result.payload.recorded !== true) {
      await expanRedis.del(lockKey);
    }
    return result;
  } catch (err) {
    await expanRedis.del(lockKey);
    throw err;
  }
}

export async function recordRefund(r: RefundEvent): Promise<{ status: number; payload: Record<string, unknown> }> {
  return withIdempotencyLock(
    `lock:refund:${r.provider}:${r.sale_id}`,
    { status: 200, payload: { ok: true, recorded: false, reason: "duplicate-or-inflight", event_type: "refund", sale_id: r.sale_id } },
    async () => {
      const existingRefund = findRefund(r.provider, r.sale_id);
      if (existingRefund) {
        return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", event_type: "refund", sale_id: r.sale_id } };
      }
      try {
        const record = await appendRefund({ provider: r.provider, sale_id: r.sale_id, ts: r.ts });
        return { status: 200, payload: { ok: true, recorded: true, event_type: "refund", sale_id: record.sale_id, refund_amount_usd: record.amount_usd } };
      } catch (err) {
        return { status: 422, payload: { ok: false, error: (err as Error).message } };
      }
    },
  );
}

export async function recordSale(result: SaleEvent): Promise<{ status: number; payload: Record<string, unknown> }> {
  return withIdempotencyLock(
    `lock:sale:${result.provider}:${result.sale_id}`,
    { status: 200, payload: { ok: true, recorded: false, reason: "duplicate-or-inflight", sale_id: result.sale_id } },
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
        return { status: 422, payload: { ok: false, error: (err as Error).message } };
      }
    },
  );
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
