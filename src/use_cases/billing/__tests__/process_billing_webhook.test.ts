import { WebhookValidationError } from "../../../domain/webhook/webhook_errors.ts";
// Regression tests for the billing webhook use case (Wave 6.2 P1): both the
// sale and refund paths must run under the distributed idempotency lock —
// an already-recorded event returns normally (no duplicate ledger writes, no
// double payout); a lock held by an unpersisted in-flight delivery is retryable (Wave 7).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { appendSale, SaleRecord } from "../../../../payments/src/ledger.ts";
import { processBillingWebhookUseCase } from "../process_billing_webhook.ts";
import { createHmac, randomBytes } from "node:crypto";
import { LegacyPaymentAdapterWrapper } from "../../../adapters/payments/legacy.adapter.ts";
import { fungiesProvider } from "../../../../payments/src/providers/fungies.ts";
import { fastspringProvider } from "../../../../payments/src/providers/fastspring.ts";
import type { PaymentProviderPort, SaleCompletedEvent, RefundIssuedEvent } from "../../../../src/domain/payments/payments.port.ts";

// Delivery is stubbed here: the sale-path tests assert the webhook contract, not mail or Dub.
// saleDeliveryConfirmed defaults to "not confirmed": a contended, recorded sale is acknowledged only when a test sets it true.
const delivery = vi.hoisted(() => ({
  deliverSaleForWebhook: vi.fn(async (_input: unknown) => undefined),
  saleDeliveryConfirmed: vi.fn(async (_provider: unknown, _saleId: unknown) => false),
}));
vi.mock("../../../../payments/src/delivery.ts", () => delivery);

// Local ledger mirror fault: when set, mirrorToLocalLedger throws before writing (ENOSPC-style local-file failure).
// Other exports stay real; with the fault clear the mirror behaves exactly as before.
const mirrorFault = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("../../../../payments/src/ledger.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../../payments/src/ledger.ts")>();
  return {
    ...orig,
    mirrorToLocalLedger: async (record: SaleRecord, salesFile?: string) => {
      mirrorFault.calls += 1;
      if (mirrorFault.fail) throw new Error("ENOSPC: local ledger write failed");
      return orig.mirrorToLocalLedger(record, salesFile);
    },
  };
});

// Local write fault at the file layer, for the first-sale mirror-order test. The mirrorToLocalLedger wrapper above cannot
// stand in for it: appendSale appends through appendRecord, not through the wrapper. Only a fault on openSync (the ledger's
// append open) fails the first-sale local write, so the old and new orders really differ under this fault.
const localWriteFault = vi.hoisted(() => ({ fail: false }));
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return {
    ...orig,
    openSync: ((...args: Parameters<typeof orig.openSync>) => {
      if (localWriteFault.fail) throw Object.assign(new Error("ENOSPC: no space left on device, open"), { code: "ENOSPC" });
      return orig.openSync(...args);
    }) as typeof orig.openSync,
  };
});

const SALE: SaleCompletedEvent = {
  eventType: "sale_completed",
  providerName: "polar",
  saleId: "sale_dup_1",
  productId: "p1",
  totalCents: 3900,
  currency: "USD",
  buyerEmailHash: "0xabc",
  buyerEmail: "buyer@example.com",
  occurredAt: "2026-09-28T00:00:00.000Z",
  providerMode: "live",
  rawPayload: null,
};

const REFUND: RefundIssuedEvent = {
  eventType: "refund_issued",
  providerName: "polar",
  saleId: "sale_dup_1",
  occurredAt: "2026-09-29T00:00:00.000Z",
  rawPayload: null,
};

function adapter(event: SaleCompletedEvent | RefundIssuedEvent): PaymentProviderPort {
  return {
    providerName: "polar",
    canHandleWebhook: () => true,
    parseAndValidateWebhook: async () => ({ isValid: true, event }),
    createCheckout: undefined as never,
  } as unknown as PaymentProviderPort;
}

// Mock the distributed lock: the first acquire wins; later acquires see the
// held lock (SETNX semantics) — mirrors expanRedis under concurrency.
const setnx = vi.fn<(...args: unknown[]) => Promise<number>>();
let mockFenceSeq = 0;

vi.mock("../../../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  // keep the real env helpers (redisRestEnv / isRedisRestConfigured) — only the client is faked
  ...(await importOriginal<typeof import("../../../../src/infrastructure/redis/redis.client.ts")>()),
  expanRedis: {
    setnx: (...a: unknown[]) => setnx(...a),
    incr: vi.fn(async () => ++mockFenceSeq),
    expire: vi.fn(async () => 1),
    compareAndDel: vi.fn(async () => 1),
    del: vi.fn(() => Promise.resolve(1)),
  },
}));
// Supabase is only reached when a test stubs SUPABASE_URL/SECRET_KEY. orders reads
// return lookupResult; audit_log inserts are captured for the dead-letter tests.
const supa = vi.hoisted(() => ({
  lookupResult: { data: null as unknown, error: null as unknown },
  // Set only by the 23505 collision tests: the conflicting row is visible to the
  // provider_adjustment_id lookup alone, so appendRefund still reaches the upsert.
  adjLookupResult: null as { data: unknown; error: unknown } | null,
  auditInserts: [] as Record<string, unknown>[],
  collisionKeys: new Set<string>(),
  auditError: null as unknown,
  upsertError: null as unknown,
  // record_webhook_conflict RPC emulation (public.webhook_conflicts): dedupe key -> row.
  conflicts: new Map<string, { id: number; delivery_count: number; args: Record<string, unknown> }>(),
  rpcError: null as unknown,
}));
function insertAudit(row: Record<string, unknown>): { error: unknown } {
  // Mirror the audit_log_collision_flag_uniq partial unique index.
  const d = (row.details ?? {}) as Record<string, unknown>;
  if (row.event === "MANUAL_REVIEW_REQUIRED_REFUND" && d.reason === "adjustment_id_collision") {
    const key = [d.provider, d.sale_id, d.adjustment_id, d.event_type, d.reason].join("|");
    if (supa.collisionKeys.has(key)) return { error: { code: "23505", message: "duplicate key value violates unique constraint \"audit_log_collision_flag_uniq\"" } };
    supa.collisionKeys.add(key);
  }
  supa.auditInserts.push(row);
  return { error: supa.auditError };
}
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    // record_webhook_conflict: upsert on (provider, event_type, adjustment_id, payload_sha256) + audit flag, atomically.
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "record_webhook_conflict") return { data: null, error: { message: `unexpected rpc ${fn}` } };
      if (supa.rpcError) return { data: null, error: supa.rpcError };
      const key = [args.p_provider, args.p_event_type, args.p_adjustment_id, args.p_payload_sha256].join("|");
      const existing = supa.conflicts.get(key);
      if (existing) existing.delivery_count += 1;
      else supa.conflicts.set(key, { id: supa.conflicts.size + 1, delivery_count: 1, args });
      insertAudit({ event: "MANUAL_REVIEW_REQUIRED_REFUND", details: args.p_flag_details });
      return { data: supa.conflicts.get(key)!.id, error: null };
    },
    from: (table: string) => {
      if (table === "audit_log") {
        return {
          insert: async (row: Record<string, unknown>) => insertAudit(row),
          // flagRefundForManualReview upserts on idempotency_key (20261004001000);
          // ignoreDuplicates maps a duplicate key to DO NOTHING — a clean success,
          // NOT a 23505 error. Only real (non-duplicate) audit failures surface.
          upsert: async (row: Record<string, unknown>) => {
            const res = insertAudit(row);
            if (res.error !== null && (res.error as { code?: string }).code === "23505") return { error: null };
            return res;
          },
        };
      }
      const filters: Record<string, unknown> = {};
      const eq = (col: string, val: unknown): object => {
        filters[col] = val;
        return { eq, in: eq, maybeSingle };
      };
      const maybeSingle = async () => {
        if (supa.adjLookupResult === null) return supa.lookupResult;
        return "provider_adjustment_id" in filters ? supa.adjLookupResult : { data: null, error: null };
      };
      const makeUpdateChain = () => ({
        eq: () => makeUpdateChain(),
        lte: () => makeUpdateChain(),
        select: async () => ({ data: [] as unknown[], error: null as unknown }),
      });
      return {
        select: () => ({ eq }),
        upsert: async () => ({ error: supa.upsertError }),
        update: () => makeUpdateChain(),
        insert: async (row: Record<string, unknown>) =>
          table === "orders" ? { error: supa.upsertError } : insertAudit(row),
      };
    },
  }),
}));

// Deterministic DB product resolver so the use case resolves creator/split
// (Sprint 15: commercial state is DB-only — the use case now resolves products
// by alias from the database instead of the file-backed product index).
const resolveCalls = vi.hoisted(() => [] as Array<[string, string]>);

vi.mock("../../../../payments/src/webhook_core.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../../payments/src/webhook_core.ts")>();
  return {
    ...orig,
    resolveProductByAlias: (alias: string, provider: string) => {
      resolveCalls.push([alias, provider]);
      // One product per checkout_mode, so the mode gate can be exercised: live, sandbox and gated.
      const products: Record<string, { productId: string; creatorHandle: string; currency: string; checkoutMode: string }> = {
        p1: { productId: "p1", creatorHandle: "c1", currency: "USD", checkoutMode: "live" },
        p_sandbox: { productId: "p_sandbox", creatorHandle: "c1", currency: "USD", checkoutMode: "sandbox" },
        p_gated: { productId: "p_gated", creatorHandle: "c1", currency: "USD", checkoutMode: "gated" },
      };
      return Promise.resolve(products[alias] ?? null);
    },
  };
});

vi.mock("../../../../payments/src/terms.ts", () => ({
  effectiveCreatorSplitPct: () => 50,
  effectiveCreatorSplitPctAsync: () => Promise.resolve(50),
}));



// The use case writes through ledger SALES_FILE (settings registry global.json).
// Point the registry module at a temp ledger path so tests never touch data/db.
// Hoisted so the settings-registry factory below can read it at import time.
const salesFileDir = vi.hoisted(() => `/tmp/hook-settings-${Date.now()}-${crypto.randomUUID()}`);
const salesFilePath = vi.hoisted(() => `${salesFileDir}/sales.jsonl`);

vi.mock("../../../../payments/src/settings_registry.ts", () => ({
  GLOBAL: {
    paths: { sales_ledger: salesFilePath },
    defaults: { currency: "USD" },
    payments: {
      webhook_tolerance_seconds: 300,
      webhook_lock_ttl_seconds: 300,
      webhook_lock_fence_ttl_seconds: 604800,
      webhook_lock_sale_prefix: "lock:sale:",
      webhook_lock_refund_prefix: "lock:refund:",
      webhook_lock_fence_suffix: ":fence",
      http_timeout_ms: 5000,
      webhook_total_budget_ms: 3000,
      sync_http_timeout_ms: 30000,
    },
    delivery: {
      bucket: "release-files",
      link_ttl_days: 7,
      signed_url_seconds: 300,
      short_domain: "go.expanpress.com",
      send_kind: "buyer_receipt",
    },
  },
  expandHome: (p: string, home: string) => (home && (p === "~" || p.startsWith("~/")) ? p : p),
  isRegisteredPaymentProvider: (name: unknown) => typeof name === "string",
  isEnabledPaymentProvider: (name: unknown) => typeof name === "string",
  paymentProviderSetting: () => undefined,
  // Used by the real legacy provider parsers in the end-to-end tests (registry fallbacks: USD only).
  getPath: (obj: unknown, dotted: string | undefined) =>
    typeof dotted === "string" && dotted !== ""
      ? dotted.split(".").reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined), obj)
      : undefined,
  isAllowedCurrency: (c: string) => String(c).toUpperCase() === "USD",
  isMoneyPath: () => process.env.NODE_ENV === "production" || process.env.VERCEL_ENV !== undefined || !!process.env.AWS_LAMBDA_FUNCTION_NAME,
}));

describe("process_billing_webhook_use_case idempotency (Wave 6.2 P1)", () => {
  it("a sale whose alias resolves to no product is a terminal 422, and the lookup uses the sale's provider", async () => {
    setnx.mockResolvedValue(1);
    resolveCalls.length = 0;
    const err = await processBillingWebhookUseCase({ headers: {}, body: "" }, [
      adapter({ ...SALE, productId: "paddle-only-alias", saleId: "sale_unknown_1" }),
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookValidationError);
    expect((err as WebhookValidationError).httpStatus).toBe(422);
    expect(resolveCalls).toContainEqual(["paddle-only-alias", "polar"]);
  });

  it("a Paddle sale looks up its alias under paddle, not a fixed provider", async () => {
    setnx.mockResolvedValue(1);
    resolveCalls.length = 0;
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [
      adapter({ ...SALE, providerName: "paddle", productId: "paddle-alias-2", saleId: "sale_paddle_1" }),
    ]).catch(() => undefined);
    expect(resolveCalls).toContainEqual(["paddle-alias-2", "paddle"]);
  });

  beforeEach(() => {
    setnx.mockReset();
    mockFenceSeq = 0;
    supa.lookupResult = { data: null, error: null };
    supa.adjLookupResult = null;
    supa.auditInserts = [];
    supa.collisionKeys.clear();
    supa.conflicts.clear();
    supa.rpcError = null;
    supa.auditError = null;
    mkdirSync(salesFileDir, { recursive: true });
    // The distributed lock is env-gated (optional infra) — stub the envs so
    // withIdempotencyLock actually consults the mocked expanRedis.
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
  });

  afterEach(() => {
    rmSync(salesFileDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const BASE_SALE: SaleRecord = {
    ts: "2026-09-27T00:00:00.000Z",
    sale_id: "sale_dup_1",
    provider: "polar",
    product_id: "p1",
    amount_usd: 39,
    creator_id: "c1",
    creator_split_pct: 50,
    creator_split_usd: 19.5,
    our_split_usd: 19.5,
    currency: "USD",
  };

  // Wave 7 in-flight contract: a held lock is NOT success — the holder may still
  // fail. Unpersisted + held → WebhookInFlightError (route answers 503, provider retries).
  it("lock held by an in-flight delivery and nothing persisted → rejects as in-flight, no write", async () => {
    setnx.mockResolvedValue(0); // another delivery holds the lock
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(SALE)])).rejects.toMatchObject({
      name: "WebhookInFlightError",
    });
    expect(() => readFileSync(salesFilePath, "utf8")).toThrow(); // ledger never written
    expect(setnx.mock.calls[0]?.[0]).toBe("lock:sale:polar:sale_dup_1");
  });

  // A recorded sale is not proof of delivery: the lock holder may still be sending the receipt, or may have
  // failed it. Contention on a recorded sale is therefore retryable (503), never an acknowledgement.
  it("lock held while the sale is durably recorded → rejects as in-flight, never acknowledged, no re-write", async () => {
    delivery.deliverSaleForWebhook.mockClear();
    await appendSale(BASE_SALE, salesFilePath);
    setnx.mockResolvedValue(0);
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(SALE)])).rejects.toMatchObject({
      name: "WebhookInFlightError",
    });
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(1);
    expect(delivery.deliverSaleForWebhook).not.toHaveBeenCalled();
  });

  it("partial refund (amount < original sale) → rejected as validation failure, never recorded", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    setnx.mockResolvedValue(1);
    const partial: RefundIssuedEvent = { ...REFUND, totalCents: 1000, refundId: "rf_partial" };
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(partial)])).rejects.toThrow(
      /validation failed: refund amount 1000c != sale 3900c/,
    );
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows.filter((r) => r.includes('"event_type":"refund"'))).toHaveLength(0);
  });

  it("over-refund (amount > original sale) → rejected, never recorded as a full reversal", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    setnx.mockResolvedValue(1);
    const over: RefundIssuedEvent = { ...REFUND, totalCents: 5000 };
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(over)])).rejects.toThrow(
      /validation failed: refund amount 5000c != sale 3900c/,
    );
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows.filter((r) => r.includes('"event_type":"refund"'))).toHaveLength(0);
  });

  it("mismatched refund writes a durable MANUAL_REVIEW_REQUIRED_REFUND audit row before rejecting", async () => {
    await appendSale(BASE_SALE, salesFilePath); // recorded locally before Supabase env is on
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    setnx.mockResolvedValue(1);
    const partial: RefundIssuedEvent = { ...REFUND, totalCents: 1000, refundId: "rf_1" };
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(partial)])).rejects.toThrow(/validation failed/);
    expect(supa.auditInserts).toHaveLength(1);
    expect(supa.auditInserts[0]).toMatchObject({
      event: "MANUAL_REVIEW_REQUIRED_REFUND",
      details: { provider: "polar", sale_id: "sale_dup_1", refund_id: "rf_1", refund_cents: 1000, sale_cents: 3900 },
    });
  });

  it("dead-letter write failure → infra error (500 path, provider retries), not a silent 400", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    supa.auditError = { message: "db down" };
    setnx.mockResolvedValue(1);
    const partial: RefundIssuedEvent = { ...REFUND, totalCents: 1000 };
    const err = await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(partial)]).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/manual-review flag write failed: db down/);
    expect((err as Error).message).not.toMatch(/validation failed/);
  });

  it("refund lock held by an in-flight delivery and no refund persisted → rejects as in-flight", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    setnx.mockResolvedValue(0);
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(REFUND)])).rejects.toMatchObject({
      name: "WebhookInFlightError",
    });
    expect(setnx.mock.calls[0]?.[0]).toBe("lock:refund:polar:sale_dup_1");
  });

  // Interleaving: the lock holder has not made the refund durable (Supabase write
  // pending/failed, so no local row either — Supabase is written FIRST). The
  // contending delivery's durable lookup errors → it must NOT be acknowledged.
  it("refund contention while the durable lookup fails → rejected, never acknowledged", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    supa.lookupResult = { data: null, error: { message: "timeout" } };
    setnx.mockResolvedValue(0);
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(REFUND)])).rejects.toThrow(
      /refund lookup failed: timeout|in flight/,
    );
  });

  // Wave 7.2 production readiness.
  it("Vercel KV env names (KV_REST_API_*) alone enable the lock", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "https://unit.test.kv.example");
    vi.stubEnv("KV_REST_API_TOKEN", "kv-token");
    setnx.mockResolvedValue(1);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(SALE)]);
    expect(setnx).toHaveBeenCalledWith("lock:sale:polar:sale_dup_1", expect.any(String), expect.anything());
  });

  it("production with no Redis configured → fails closed (throws), never processes unlocked", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(SALE)])).rejects.toThrow(
      /lock unavailable: Redis is not configured in a money-path runtime/,
    );
    expect(() => readFileSync(salesFilePath, "utf8")).toThrow(); // nothing written
  });

  it("production with Supabase unconfigured → mismatched refund is an infra error, not a quiet 400", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    vi.stubEnv("VERCEL_ENV", "production");
    setnx.mockResolvedValue(1);
    const partial: RefundIssuedEvent = { ...REFUND, totalCents: 1000 };
    const err = await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(partial)]).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/manual-review flag cannot be persisted/);
    expect((err as Error).message).not.toMatch(/validation failed/);
  });

  it("a mismatched refund for an already-refunded sale is flagged, not acknowledged as a duplicate", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    setnx.mockResolvedValue(1);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({ ...REFUND, totalCents: 3900 })]); // full refund recorded
    await expect(
      processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({ ...REFUND, totalCents: 500, refundId: "rf_2" })]),
    ).rejects.toThrow(/validation failed: refund amount 500c != sale 3900c/);
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows.filter((r) => r.includes('"event_type":"refund"'))).toHaveLength(1);
  });

  it("full refund with an explicit amount equal to the sale → recorded", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    setnx.mockResolvedValue(1);
    const full: RefundIssuedEvent = { ...REFUND, totalCents: 3900 };
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(full)]);
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows.filter((r) => r.includes('"event_type":"refund"'))).toHaveLength(1);
  });

  it("a recorded sale short-circuits inside the lock (recorded:false, no re-write)", async () => {
    setnx.mockResolvedValue(1); // lock always acquired
    const base: SaleRecord = {
      ts: "2026-09-27T00:00:00.000Z",
      sale_id: "sale_dup_1",
      provider: "polar",
      product_id: "p1",
      amount_usd: 39,
      creator_id: "c1",
      creator_split_pct: 50,
      creator_split_usd: 19.5,
      our_split_usd: 19.5,
      currency: "USD",
    };
    await appendSale(base, salesFilePath);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(SALE)]);
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(1); // only the pre-existing record
    expect(setnx).toHaveBeenCalledWith("lock:sale:polar:sale_dup_1", expect.any(String), expect.anything());
  });

  it("a retry for a recorded sale re-attempts delivery (a prior attempt may have failed after the ledger write)", async () => {
    setnx.mockResolvedValue(1);
    await appendSale(BASE_SALE, salesFilePath);
    delivery.deliverSaleForWebhook.mockClear();
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(SALE)]);
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledTimes(1);
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledWith({ provider: "polar", saleId: "sale_dup_1", productAlias: "p1", buyerEmail: "buyer@example.com", fence: expect.any(Number) });
  });

  it("a newly recorded sale delivers under the provider that issued it, not a shared default", async () => {
    setnx.mockResolvedValue(1);
    delivery.deliverSaleForWebhook.mockClear();
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({ ...SALE, providerName: "fungies", saleId: "sale_fungies_new" })]);
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledTimes(1);
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledWith(expect.objectContaining({ provider: "fungies", saleId: "sale_fungies_new" }));
  });

  it("a delivery failure on retry propagates as a non-validation error, so the webhook answers 500 and the provider retries", async () => {
    setnx.mockResolvedValue(1);
    await appendSale(BASE_SALE, salesFilePath);
    delivery.deliverSaleForWebhook.mockRejectedValueOnce(new Error("resend down"));
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(SALE)])).rejects.toThrow("resend down");
  });

  it("a successful delivery on retry resolves (webhook answers 200)", async () => {
    setnx.mockResolvedValue(1);
    await appendSale(BASE_SALE, salesFilePath);
    delivery.deliverSaleForWebhook.mockResolvedValueOnce(undefined);
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(SALE)])).resolves.toBeUndefined();
  });

  it("duplicate refund → returns normally, exactly 1 refund row", async () => {
    // Record the linked sale first (refunds must reference a recorded sale).
    await appendSale(
      {
        ts: "2026-09-27T00:00:00.000Z",
        sale_id: "sale_dup_1",
        provider: "polar",
        product_id: "p1",
        amount_usd: 39,
        creator_id: "c1",
        creator_split_pct: 50,
        creator_split_usd: 19.5,
        our_split_usd: 19.5,
        currency: "USD",
      },
      salesFilePath,
    );
    // first refund acquires; the duplicate (e.g. adjustment.updated after .created) hits the held
    // lock and is confirmed from ledger state (refund recorded, not reversed).
    setnx.mockResolvedValueOnce(1).mockResolvedValue(0);
    const a = adapter(REFUND);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [a]);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [a]);
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(2); // 1 sale + 1 refund — no duplicate refund row
    expect(rows.filter((r) => r.includes('"event_type":"refund"'))).toHaveLength(1);
  });

  it("handles refund_reversed: sale -> refund -> reversal nets back to sale", async () => {
    await appendSale(
      {
        ts: "2026-09-27T00:00:00.000Z",
        sale_id: "sale_rev_1",
        provider: "polar",
        product_id: "p1",
        amount_usd: 39,
        creator_id: "c1",
        creator_split_pct: 50,
        creator_split_usd: 19.5,
        our_split_usd: 19.5,
        currency: "USD",
      },
      salesFilePath,
    );
    setnx.mockResolvedValue(1);

    // 1. Issue refund
    const refundEvent: RefundIssuedEvent = {
      eventType: "refund_issued",
      providerName: "polar",
      saleId: "sale_rev_1",
      occurredAt: "2026-09-28T00:00:00.000Z",
      rawPayload: null,
    };
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(refundEvent)]);

    // 2. Issue refund_reversed
    const reversalEvent = {
      eventType: "refund_reversed",
      providerName: "polar",
      saleId: "sale_rev_1",
      totalCents: 3900,
      currency: "USD",
      occurredAt: "2026-09-29T00:00:00.000Z",
      rawPayload: null,
    };
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(reversalEvent as never)]);

    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(3);
    const revRow = JSON.parse(rows[2]);
    expect(revRow.event_type).toBe("refund_reversal");
    expect(revRow.creator_split_usd).toBe(19.5);
    expect(revRow.our_split_usd).toBe(19.5);
  });

  // A sale event with no buyer email cannot be sent a download link. Delivery would throw on every retry,
  // a 500 loop. A non-Paddle sale without an email is refused with a final 422 instead.
  it("a non-Paddle sale with no buyer email is refused (422) before any write, not retried into a 500 loop", async () => {
    delivery.deliverSaleForWebhook.mockClear();
    setnx.mockResolvedValue(1);
    const fungies: SaleCompletedEvent = { ...SALE, providerName: "fungies", saleId: "sale_fungies_1", buyerEmail: undefined };
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(fungies)])).rejects.toMatchObject({
      message: expect.stringMatching(/no buyer email/),
      httpStatus: 422,
    });
    expect(() => readFileSync(salesFilePath, "utf8")).toThrow(); // nothing written
    expect(delivery.deliverSaleForWebhook).not.toHaveBeenCalled();
  });

  it("a recorded non-Paddle sale with no buyer email is also refused (422), not acknowledged or looped", async () => {
    delivery.deliverSaleForWebhook.mockClear();
    setnx.mockResolvedValue(1);
    await appendSale({ ...BASE_SALE, provider: "fungies", sale_id: "sale_fungies_2" }, salesFilePath);
    const fungies: SaleCompletedEvent = { ...SALE, providerName: "fungies", saleId: "sale_fungies_2", buyerEmail: undefined };
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(fungies)])).rejects.toMatchObject({ httpStatus: 422 });
    expect(delivery.deliverSaleForWebhook).not.toHaveBeenCalled();
  });

  it("a USD sale for a EUR product is rejected by the use case (422)", async () => {
    setnx.mockResolvedValue(1);
    // p1 is USD in mock. Let's send currency="EUR" for p1:
    const eurSale: SaleCompletedEvent = {
      ...SALE,
      saleId: "sale_eur_mismatch",
      currency: "EUR",
    };
    const a = adapter(eurSale);
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [a])).rejects.toMatchObject({
      message: expect.stringContaining("currency EUR != product currency USD"),
      httpStatus: 422,
    });
  });

  it("Defect B: a EUR 3900c refund against a USD 3900c sale gets flagged currency_mismatch and not recorded", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);

    await appendSale(
      {
        ts: "2026-09-27T00:00:00.000Z",
        sale_id: "sale_eur_ref_mismatch",
        provider: "polar",
        product_id: "p1",
        amount_usd: 39,
        creator_id: "c1",
        creator_split_pct: 50,
        creator_split_usd: 19.5,
        our_split_usd: 19.5,
        currency: "USD",
      },
      salesFilePath,
    );

    const refundEvent: RefundIssuedEvent = {
      eventType: "refund_issued",
      providerName: "polar",
      saleId: "sale_eur_ref_mismatch",
      refundId: "ref_eur_1",
      totalCents: 3900,
      currency: "EUR",
      occurredAt: "2026-09-28T00:00:00.000Z",
      rawPayload: null,
    };

    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(refundEvent)])).rejects.toThrow(
      /Webhook validation failed: refund currency EUR != sale USD for sale sale_eur_ref_mismatch/,
    );

    // Audit log should have currency_mismatch entry
    expect(supa.auditInserts).toHaveLength(1);
    expect(supa.auditInserts[0]).toMatchObject({
      event: "MANUAL_REVIEW_REQUIRED_REFUND",
      details: expect.objectContaining({
        reason: "currency_mismatch",
        sale_id: "sale_eur_ref_mismatch",
        refund_id: "ref_eur_1",
        refund_cents: 3900,
        sale_cents: 3900,
      }),
    });

    // Check no refund was appended
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]).event_type).toBeUndefined();
  });

  it("Defect A: a reversal with no recorded refund is flagged reversal_without_refund and acked 200 (no retry storm, no clock heuristic)", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);

    await appendSale(
      {
        ts: "2026-09-27T00:00:00.000Z",
        sale_id: "sale_no_refund",
        provider: "polar",
        product_id: "p1",
        amount_usd: 39,
        creator_id: "c1",
        creator_split_pct: 50,
        creator_split_usd: 19.5,
        our_split_usd: 19.5,
        currency: "USD",
      },
      salesFilePath,
    );

    const reversalEvent = {
      eventType: "refund_reversed",
      providerName: "polar",
      saleId: "sale_no_refund",
      totalCents: 3900,
      currency: "USD",
      occurredAt: new Date().toISOString(),
      rawPayload: null,
    };

    await expect(
      processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(reversalEvent as never)]),
    ).resolves.toBeUndefined();

    // Check manual review flag in audit_log
    expect(supa.auditInserts).toHaveLength(1);
    expect(supa.auditInserts[0]).toMatchObject({
      event: "MANUAL_REVIEW_REQUIRED_REFUND",
      details: expect.objectContaining({
        reason: "reversal_without_refund",
        sale_id: "sale_no_refund",
      }),
    });

    // Verify nothing appended to ledger
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(1);
  });

  it("item 3: EUR refund arriving before its sale must not flag currency_mismatch and rejects retryably (throws error not starting with Webhook validation failed)", async () => {
    setnx.mockResolvedValue(1);
    const refundEvent: RefundIssuedEvent = {
      eventType: "refund_issued",
      providerName: "polar",
      saleId: "sale_before_arrived",
      totalCents: 3900,
      currency: "EUR",
      occurredAt: "2026-09-28T00:00:00.000Z",
      rawPayload: null,
    };

    const promise = processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(refundEvent)]);
    await expect(promise).rejects.toThrow();
    await promise.catch((err: Error) => {
      expect(err.message).not.toMatch(/^Webhook validation failed/);
    });
    expect(supa.auditInserts).toHaveLength(0);
  });

  it("item 8: refund after refund_reversal flags refund_after_reversal and returns 200 { ok: true, recorded: false, reason: 'manual_review' }", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);

    await appendSale(
      {
        ts: "2026-09-27T00:00:00.000Z",
        sale_id: "sale_with_reversal",
        provider: "polar",
        product_id: "p1",
        amount_usd: 39,
        creator_id: "c1",
        creator_split_pct: 50,
        creator_split_usd: 19.5,
        our_split_usd: 19.5,
        currency: "USD",
      },
      salesFilePath,
    );

    const firstRefund: RefundIssuedEvent = {
      eventType: "refund_issued",
      providerName: "polar",
      saleId: "sale_with_reversal",
      totalCents: 3900,
      currency: "USD",
      occurredAt: "2026-09-28T00:00:00.000Z",
      rawPayload: null,
    };
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(firstRefund)]);

    const reversalEvent = {
      eventType: "refund_reversed",
      providerName: "polar",
      saleId: "sale_with_reversal",
      totalCents: 3900,
      currency: "USD",
      occurredAt: "2026-09-29T00:00:00.000Z",
      rawPayload: null,
    };
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(reversalEvent as never)]);

    // Now a second refund arrives for the same sale which already had a reversal
    const secondRefund: RefundIssuedEvent = {
      eventType: "refund_issued",
      providerName: "polar",
      saleId: "sale_with_reversal",
      refundId: "rf_second",
      totalCents: 3900,
      currency: "USD",
      occurredAt: "2026-09-30T00:00:00.000Z",
      rawPayload: null,
    };

    supa.auditInserts = []; // clear previous
    await expect(
      processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(secondRefund)]),
    ).resolves.toBeUndefined();

    expect(supa.auditInserts).toHaveLength(1);
    expect(supa.auditInserts[0]).toMatchObject({
      event: "MANUAL_REVIEW_REQUIRED_REFUND",
      details: expect.objectContaining({
        reason: "refund_after_reversal",
        sale_id: "sale_with_reversal",
      }),
    });
  });

  it("a contended refund that would fail the in-lock checks (partial / foreign currency / unverifiable) retries instead of being confirmed", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);
    await appendSale(
      { ts: "2026-09-27T00:00:00.000Z", sale_id: "sale_contended_bad", provider: "polar", product_id: "p1", amount_usd: 39, creator_id: "c1", creator_split_pct: 50, creator_split_usd: 19.5, our_split_usd: 19.5, currency: "USD" },
      salesFilePath,
    );
    const full: RefundIssuedEvent = { eventType: "refund_issued", providerName: "polar", saleId: "sale_contended_bad", totalCents: 3900, currency: "USD", occurredAt: "2026-09-28T00:00:00.000Z", rawPayload: null };
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(full)]);

    setnx.mockResolvedValue(0); // lock held
    for (const bad of [
      { ...full, totalCents: 2000 },
      { ...full, currency: "EUR" },
      { ...full, totalCents: undefined, amountUnverifiable: true },
    ] as RefundIssuedEvent[]) {
      await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(bad)])).rejects.toThrow(/in flight/);
    }
    // the matching duplicate (adjustment.updated after .created) is still confirmed
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(full)])).resolves.toBeUndefined();
  });

  it("after a won dispute, a NEW chargeback hitting the held lock is not confirmed from the old refund row (retries)", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);
    await appendSale(
      { ts: "2026-09-27T00:00:00.000Z", sale_id: "sale_rev_then_cb", provider: "polar", product_id: "p1", amount_usd: 39, creator_id: "c1", creator_split_pct: 50, creator_split_usd: 19.5, our_split_usd: 19.5, currency: "USD" },
      salesFilePath,
    );
    const refund: RefundIssuedEvent = { eventType: "refund_issued", providerName: "polar", saleId: "sale_rev_then_cb", totalCents: 3900, currency: "USD", occurredAt: "2026-09-28T00:00:00.000Z", rawPayload: null };
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(refund)]);
    const reversal = { eventType: "refund_reversed", providerName: "polar", saleId: "sale_rev_then_cb", totalCents: 3900, currency: "USD", occurredAt: "2026-09-29T00:00:00.000Z", rawPayload: null };
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(reversal as never)]);

    setnx.mockResolvedValue(0); // lock held by another delivery
    const secondChargeback: RefundIssuedEvent = { ...refund, refundId: "adj_2", occurredAt: "2026-09-30T00:00:00.000Z" };
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(secondChargeback)])).rejects.toThrow(/in flight/);
  });

  it("an unsettled Polar refund (pending, failed or canceled) is never applied: flagged refund_not_settled, rejected 400, no refund row", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);
    await appendSale(
      { ts: "2026-09-27T00:00:00.000Z", sale_id: "sale_unsettled", provider: "polar", product_id: "p1", amount_usd: 39, creator_id: "c1", creator_split_pct: 50, creator_split_usd: 19.5, our_split_usd: 19.5, currency: "USD" },
      salesFilePath,
    );
    const unsettled: RefundIssuedEvent = {
      eventType: "refund_issued",
      providerName: "polar",
      saleId: "sale_unsettled",
      refundId: "rf_pending",
      totalCents: 3900,
      currency: "USD",
      settled: false,
      occurredAt: "2026-09-28T00:00:00.000Z",
      rawPayload: null,
    };
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(unsettled)])).rejects.toThrow(/refund not settled/);

    expect(supa.auditInserts).toHaveLength(1);
    expect(supa.auditInserts[0]).toMatchObject({
      event: "MANUAL_REVIEW_REQUIRED_REFUND",
      details: expect.objectContaining({ reason: "refund_not_settled", sale_id: "sale_unsettled", refund_id: "rf_pending", refund_cents: 3900 }),
    });
    // Only the sale row exists: the unsettled refund never reached the ledger.
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(1);
  });

  it("Defect C: reversal with mismatched amount returns 200 recorded:false and flags reversal_amount_mismatch", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);

    await appendSale(
      {
        ts: "2026-09-27T00:00:00.000Z",
        sale_id: "sale_partial_rev",
        provider: "polar",
        product_id: "p1",
        amount_usd: 39,
        creator_id: "c1",
        creator_split_pct: 50,
        creator_split_usd: 19.5,
        our_split_usd: 19.5,
        currency: "USD",
      },
      salesFilePath,
    );

    const refundEvent: RefundIssuedEvent = {
      eventType: "refund_issued",
      providerName: "polar",
      saleId: "sale_partial_rev",
      totalCents: 3900,
      currency: "USD",
      occurredAt: "2026-09-28T00:00:00.000Z",
      rawPayload: null,
    };
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(refundEvent)]);

    const reversalEvent = {
      eventType: "refund_reversed",
      providerName: "polar",
      saleId: "sale_partial_rev",
      totalCents: 2000, // partial/mismatch!
      currency: "USD",
      occurredAt: "2026-09-29T00:00:00.000Z",
      rawPayload: null,
    };

    await expect(
      processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(reversalEvent as never)]),
    ).resolves.toBeUndefined();

    // Check manual review audit log
    expect(supa.auditInserts).toHaveLength(1);
    expect(supa.auditInserts[0]).toMatchObject({
      event: "MANUAL_REVIEW_REQUIRED_REFUND",
      details: expect.objectContaining({
        reason: "reversal_amount_mismatch",
        sale_id: "sale_partial_rev",
        refund_cents: 2000,
        sale_cents: 3900,
      }),
    });

    // Verify no reversal appended (only sale + refund = 2 rows)
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(2);
  });

  it("Defect C: reversal with missing totalCents returns 200 recorded:false and flags reversal_amount_unverifiable", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);

    await appendSale(
      {
        ts: "2026-09-27T00:00:00.000Z",
        sale_id: "sale_no_amount_rev",
        provider: "polar",
        product_id: "p1",
        amount_usd: 39,
        creator_id: "c1",
        creator_split_pct: 50,
        creator_split_usd: 19.5,
        our_split_usd: 19.5,
        currency: "USD",
      },
      salesFilePath,
    );

    const refundEvent: RefundIssuedEvent = {
      eventType: "refund_issued",
      providerName: "polar",
      saleId: "sale_no_amount_rev",
      totalCents: 3900,
      currency: "USD",
      occurredAt: "2026-09-28T00:00:00.000Z",
      rawPayload: null,
    };
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(refundEvent)]);

    const reversalEvent = {
      eventType: "refund_reversed",
      providerName: "polar",
      saleId: "sale_no_amount_rev",
      // totalCents absent!
      currency: "USD",
      occurredAt: "2026-09-29T00:00:00.000Z",
      rawPayload: null,
    };

    await expect(
      processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(reversalEvent as never)]),
    ).resolves.toBeUndefined();

    // Check manual review audit log
    expect(supa.auditInserts).toHaveLength(1);
    expect(supa.auditInserts[0]).toMatchObject({
      event: "MANUAL_REVIEW_REQUIRED_REFUND",
      details: expect.objectContaining({
        reason: "reversal_amount_unverifiable",
        sale_id: "sale_no_amount_rev",
        refund_cents: null,
        sale_cents: 3900,
      }),
    });

    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(2);
  });

  it("Defect C: reversal with currency mismatch returns 200 recorded:false and flags currency_mismatch", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);

    await appendSale(
      {
        ts: "2026-09-27T00:00:00.000Z",
        sale_id: "sale_curr_mismatch_rev",
        provider: "polar",
        product_id: "p1",
        amount_usd: 39,
        creator_id: "c1",
        creator_split_pct: 50,
        creator_split_usd: 19.5,
        our_split_usd: 19.5,
        currency: "USD",
      },
      salesFilePath,
    );

    const refundEvent: RefundIssuedEvent = {
      eventType: "refund_issued",
      providerName: "polar",
      saleId: "sale_curr_mismatch_rev",
      totalCents: 3900,
      currency: "USD",
      occurredAt: "2026-09-28T00:00:00.000Z",
      rawPayload: null,
    };
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(refundEvent)]);

    const reversalEvent = {
      eventType: "refund_reversed",
      providerName: "polar",
      saleId: "sale_curr_mismatch_rev",
      totalCents: 3900,
      currency: "EUR", // currency mismatch!
      occurredAt: "2026-09-29T00:00:00.000Z",
      rawPayload: null,
    };

    await expect(
      processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(reversalEvent as never)]),
    ).resolves.toBeUndefined();

    // Check manual review audit log
    expect(supa.auditInserts).toHaveLength(1);
    expect(supa.auditInserts[0]).toMatchObject({
      event: "MANUAL_REVIEW_REQUIRED_REFUND",
      details: expect.objectContaining({
        reason: "currency_mismatch",
        sale_id: "sale_curr_mismatch_rev",
        refund_cents: 3900,
        sale_cents: 3900,
      }),
    });

    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(2);
  });

  // ------------------------------------------------------------------
  // provider_adjustment_id dedupe (chargeback replay hardening)
  // ------------------------------------------------------------------

  const CB_SALE = { ts: "2026-09-27T00:00:00.000Z", sale_id: "sale_adj_dedupe", provider: "paddle", product_id: "p1", amount_usd: 39, creator_id: "c1", creator_split_pct: 50, creator_split_usd: 19.5, our_split_usd: 19.5, currency: "USD" };
  const cbRefund = (adjustmentId: string, ts = "2026-09-28T00:00:00.000Z"): RefundIssuedEvent => ({
    eventType: "refund_issued", providerName: "paddle", saleId: CB_SALE.sale_id,
    refundId: adjustmentId, providerAdjustmentId: adjustmentId,
    totalCents: 3900, currency: "USD", occurredAt: ts, rawPayload: null,
  });

  it("adjustment-id dedupe: chargeback -> refund row stores provider_adjustment_id; replayed chargeback -> 200, no new row", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);
    await appendSale({ ...CB_SALE }, salesFilePath);

    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_abc"))]);
    let rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows.at(1) ?? "null")).toMatchObject({ event_type: "refund", provider_adjustment_id: "adj_abc" });

    // Replay: same adjustment id, no lock contention, must not write a new row.
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_abc"))]);
    rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(2); // still sale + one refund
  });

  it("contended replay with a recorded adjustment id but a mismatched amount is NOT confirmed (retries, like in-lock)", async () => {
    setnx.mockResolvedValue(1);
    await appendSale({ ...CB_SALE }, salesFilePath);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_same"))]);

    setnx.mockResolvedValue(0); // another delivery holds the refund lock
    const mismatched: RefundIssuedEvent = { ...cbRefund("adj_same"), totalCents: 1000 };
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(mismatched)])).rejects.toMatchObject({
      name: "WebhookInFlightError",
    });
    // ...while the matching replay under contention is still confirmed.
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_same"))])).resolves.toBeUndefined();
  });

  it("contended refund with no Supabase client in a money-path runtime -> the confirm predicate throws, not a 503 in-flight", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    vi.stubEnv("VERCEL_ENV", "production");
    setnx.mockResolvedValue(0);
    const err = await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(REFUND)]).catch((e: Error) => e);
    expect((err as Error).name).not.toBe("WebhookInFlightError");
    expect((err as Error).message).toMatch(/refund lookup unavailable: client not configured in a money-path runtime/);
  });

  it("contended replay whose adjustment-id confirm lookup errors -> rethrows the lookup error (500, retried), never not-persisted (503)", async () => {
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    setnx.mockResolvedValue(1);
    await appendSale({ ...CB_SALE }, salesFilePath);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_confirm_a"))]);

    // A different adjustment id is absent locally, so the confirm lookup reaches Supabase, which errors.
    supa.adjLookupResult = { data: null, error: { message: "db down" } };
    setnx.mockResolvedValue(0);
    try {
      const err = await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_confirm_b"))]).catch((e: Error) => e);
      expect((err as Error).name).not.toBe("WebhookInFlightError");
      expect((err as Error).message).toMatch(/adjustment-id lookup failed: db down/);
    } finally {
      supa.adjLookupResult = null;
      setnx.mockResolvedValue(1);
    }
  });

  it("a retry for a sale held only in Supabase (local append lost) delivers, then mirrors it into the local ledger", async () => {
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    setnx.mockResolvedValue(1);
    delivery.deliverSaleForWebhook.mockClear();
    supa.lookupResult = {
      data: {
        provider: "polar", sale_id: "sale_dup_1", product_id: "p1", amount_usd: 39, creator_id: "c1",
        creator_split_pct: 50, creator_split_usd: 19.5, our_split_usd: 19.5, currency: "USD", event_type: "sale",
        occurred_at: "2026-09-27T00:00:00.000Z", email_hash: null, attribution_id: null, provider_adjustment_id: null,
      },
      error: null,
    };
    try {
      await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(SALE)]);
    } finally {
      supa.lookupResult = { data: null, error: null };
    }
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows.at(0) ?? "null")).toMatchObject({ provider: "polar", sale_id: "sale_dup_1", event_type: "sale" });
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledTimes(1);
  });

  it("adjustment-id lookup failure with a refund already recorded -> throws (provider retries), no manual-review flag", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);
    await appendSale({ ...CB_SALE }, salesFilePath);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_first"))]);

    // A different adjustment id is not in the local file, so the lookup reaches Supabase, which is down.
    supa.lookupResult = { data: null, error: { message: "db down" } };
    supa.auditInserts = [];
    try {
      await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_second"))])).rejects.toThrow(/adjustment-id lookup failed/);
      expect(supa.auditInserts).toEqual([]);
    } finally {
      supa.lookupResult = { data: null, error: null };
    }
  });

  it("won dispute (chargeback_reverse) -> refund_reversal row with adjustment id, net restored; replayed chargeback after the reversal -> 200 duplicate, no manual-review flag", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);
    await appendSale({ ...CB_SALE }, salesFilePath);

    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_win"))]);
    const reversal = {
      eventType: "refund_reversed", providerName: "paddle", saleId: CB_SALE.sale_id,
      refundId: "adj_win", providerAdjustmentId: "adj_win",
      totalCents: 3900, currency: "USD", occurredAt: "2026-09-29T00:00:00.000Z", rawPayload: null,
    };
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(reversal as never)]);

    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ event_type: "refund_reversal", provider_adjustment_id: "adj_win", our_split_usd: 19.5, creator_split_usd: 19.5 });

    // Replaying the original chargeback after the won dispute: 200 duplicate via
    // the adjustment id — NOT the refund_after_reversal manual-review flag.
    supa.auditInserts = [];
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_win", "2026-09-30T00:00:00.000Z"))]);
    expect(supa.auditInserts).toHaveLength(0); // no manual-review flag
    const after = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(after).toHaveLength(3);
  });

  it("adjustment.created pending (ignored) then adjustment.updated approved records ONCE; a later .updated replay does not duplicate", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);
    await appendSale({ ...CB_SALE }, salesFilePath);

    // .created with status=pending is ignored by the adapter shape used in the use
    // case tests — simulate the pending delivery by never delivering it, then the
    // .updated approved event records the refund.
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_once"))]);
    // .updated re-delivery (same adjustment id, later ts) — duplicate, no write.
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_once", "2026-09-29T00:00:00.000Z"))]);

    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(2); // sale + exactly one refund
  });

  it("23505 on orders_provider_adjustment_id_uniq during insert is a replay -> 200, no throw", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);
    await appendSale({ ...CB_SALE }, salesFilePath);

    // A concurrent delivery won the unique index: the REAL appendRefund hits Supabase's
    // 23505 (PostgREST error shape) and the conflicting row MATCHES the event, so it
    // must surface as a replay, not a 500.
    supa.upsertError = { code: "23505", message: 'duplicate key value violates unique constraint "orders_provider_adjustment_id_uniq"' };
    supa.adjLookupResult = conflicts();
    try {
      // Resolves (route answers 200) instead of throwing (route answers 500).
      await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_race"))])).resolves.toBeUndefined();
    } finally {
      supa.upsertError = null;
      supa.adjLookupResult = null;
    }
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(1); // durable write failed first, so no local refund row
  });

  it("23505 on an UNRELATED constraint is NOT a replay -> error propagates (500/retry)", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);
    await appendSale({ ...CB_SALE }, salesFilePath);

    supa.upsertError = { code: "23505", message: 'duplicate key value violates unique constraint "orders_provider_sale_id_event_type_key"' };
    try {
      await expect(
        processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_other"))]),
      ).rejects.toThrow(/orders_provider_sale_id_event_type_key/);
    } finally {
      supa.upsertError = null;
    }
  });

  // ------------------------------------------------------------------
  // 23505 collision contract: the conflicting row must MATCH the event
  // (same sale, same amount, same currency) before it is treated as a replay.
  // ------------------------------------------------------------------

  const conflicts = (saleId = CB_SALE.sale_id, amountUsd = 39, currency = "USD") => ({
    data: {
      occurred_at: "2026-09-28T00:00:00.000Z",
      sale_id: saleId,
      provider: "paddle",
      product_id: "p1",
      amount_usd: amountUsd,
      creator_id: "c1",
      creator_split_pct: 50,
      creator_split_usd: 19.5,
      our_split_usd: 19.5,
      currency,
    },
    error: null as unknown,
  });

  const race23505 = () => {
    supa.upsertError = { code: "23505", message: 'duplicate key value violates unique constraint "orders_provider_adjustment_id_uniq"' };
  };

  const cbReversal = (adjustmentId: string) => ({
    eventType: "refund_reversed" as const,
    providerName: "paddle",
    saleId: CB_SALE.sale_id,
    refundId: adjustmentId,
    providerAdjustmentId: adjustmentId,
    totalCents: 3900,
    currency: "USD",
    occurredAt: "2026-09-29T00:00:00.000Z",
    rawPayload: null,
  });

  const cleanup23505 = () => {
    supa.upsertError = null;
    supa.adjLookupResult = null;
  };

  const expectConflictPending = (out: unknown, sale = CB_SALE.sale_id) => {
    expect(out).toMatchObject({ status: 200, payload: { ok: true, recorded: false, reason: "conflict_pending", sale_id: sale } });
    expect((out as { payload: { conflict_id: number } }).payload.conflict_id).toBeGreaterThanOrEqual(1);
  };

  const expect503Collision = (err: unknown) => {
    const e = err as Error & { httpStatus?: number };
    expect(e.message).toMatch(/^Webhook retryable:/);
    expect(e.httpStatus).toBe(503);
  };

  describe("23505 adjustment-id collision contract (refund + reversal)", () => {
    beforeEach(async () => {
      process.env.SUPABASE_URL = "https://example.supabase.co";
      process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
      setnx.mockResolvedValue(1);
      await appendSale({ ...CB_SALE }, salesFilePath);
    });

    // F3: the batch loop's conflict and throw paths. A conflict is already durable in the inbox, so a
    // terminal sibling failure still decides the response; a conflict after a failed event still runs.
    const batch = (events: unknown[]): PaymentProviderPort =>
      ({
        providerName: "paddle",
        canHandleWebhook: () => true,
        parseAndValidateWebhook: async () => ({ isValid: true, event: events[0], followingEvents: events.slice(1) }),
        createCheckout: undefined as never,
      }) as unknown as PaymentProviderPort;
    const noEmailSale = { ...SALE, providerName: "fungies", saleId: "sale_no_email", buyerEmail: undefined };

    it("batch [conflicting refund, ignored] → the conflict_pending outcome is reported", async () => {
      race23505();
      supa.adjLookupResult = conflicts("sale_OTHER");
      try {
        const out = await processBillingWebhookUseCase({ headers: {}, body: "" }, [
          batch([cbRefund("adj_batch_c"), { eventType: "ignored", providerName: "paddle", reason: "test" }]),
        ]);
        expectConflictPending(out);
        expect(supa.conflicts.size).toBe(1);
      } finally {
        cleanup23505();
      }
    });

    it("batch [no-email sale (422), conflicting refund] → the conflict is still stored, the delivery answers 422", async () => {
      race23505();
      supa.adjLookupResult = conflicts("sale_OTHER");
      try {
        const run = processBillingWebhookUseCase({ headers: {}, body: "" }, [batch([noEmailSale, cbRefund("adj_batch_t")])]);
        await expect(run).rejects.toMatchObject({ name: "WebhookValidationError", httpStatus: 422 });
        expect(supa.conflicts.size).toBe(1);
      } finally {
        cleanup23505();
      }
    });

    it("refund: 23505 + matching conflicting row -> resolves 200", async () => {
      race23505();
      supa.adjLookupResult = conflicts();
      try {
        await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_match"))])).resolves.toBeUndefined();
        expect(supa.auditInserts).toHaveLength(0);
      } finally {
        cleanup23505();
      }
    });

    it("refund: 23505 + conflicting row with a DIFFERENT sale_id -> 200 conflict_pending + inbox row + adjustment_id_collision flag", async () => {
      race23505();
      supa.adjLookupResult = conflicts("sale_OTHER");
      try {
        expectConflictPending(await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_other_sale"))]));
        expect(supa.auditInserts).toHaveLength(1);
        expect(supa.auditInserts[0]).toMatchObject({
          event: "MANUAL_REVIEW_REQUIRED_REFUND",
          details: expect.objectContaining({
            reason: "adjustment_id_collision",
            provider: "paddle",
            sale_id: CB_SALE.sale_id,
            refund_cents: 3900,
            sale_cents: 3900,
          }),
        });
      } finally {
        cleanup23505();
      }
    });

    it("refund: 23505 + conflicting row with a different amount -> 200 conflict_pending + inbox row", async () => {
      race23505();
      supa.adjLookupResult = conflicts(CB_SALE.sale_id, 12.5);
      try {
        expectConflictPending(await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_other_amt"))]));
        expect(supa.auditInserts).toHaveLength(1);
        expect(supa.auditInserts[0]).toMatchObject({
          event: "MANUAL_REVIEW_REQUIRED_REFUND",
          details: expect.objectContaining({ reason: "adjustment_id_collision" }),
        });
      } finally {
        cleanup23505();
      }
    });

    it("refund: 23505 + same sale/amount but different currency -> 200 conflict_pending + inbox row + collision flag", async () => {
      race23505();
      supa.adjLookupResult = conflicts(CB_SALE.sale_id, 39, "EUR");
      try {
        expectConflictPending(await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_other_cur"))]));
        expect(supa.auditInserts).toHaveLength(1);
        expect(supa.auditInserts[0]).toMatchObject({
          event: "MANUAL_REVIEW_REQUIRED_REFUND",
          details: expect.objectContaining({ reason: "adjustment_id_collision" }),
        });
      } finally {
        cleanup23505();
      }
    });

    it("redelivery: two identical refund collisions -> 200 both times, ONE inbox row (delivery_count 2), exactly ONE flag row, forensic context recorded", async () => {
      race23505();
      supa.adjLookupResult = conflicts("sale_OTHER", 12.5, "EUR");
      try {
        const first = await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_redeliver"))]);
        const second = await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_redeliver"))]);
        expectConflictPending(first);
        expectConflictPending(second);
        expect((second as { payload: { conflict_id: number } }).payload.conflict_id).toBe((first as { payload: { conflict_id: number } }).payload.conflict_id);
        expect(supa.conflicts.size).toBe(1);
        expect([...supa.conflicts.values()][0]?.delivery_count).toBe(2);
        expect(supa.auditInserts).toHaveLength(1);
        expect(supa.auditInserts[0]).toMatchObject({
          details: expect.objectContaining({
            reason: "adjustment_id_collision",
            adjustment_id: "adj_redeliver",
            event_type: "refund",
            refund_cents: 3900,
            incoming_currency: "USD",
            conflicting_sale_id: "sale_OTHER",
            conflicting_cents: 1250,
            conflicting_currency: "EUR",
          }),
        });
      } finally {
        cleanup23505();
      }
    });

    it("inbox row stores the normalized event only (no raw body, no buyer data) and the conflicting row", async () => {
      race23505();
      supa.adjLookupResult = conflicts("sale_OTHER", 12.5, "EUR");
      try {
        expectConflictPending(await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_normalized"))]));
        const firstConflict = [...supa.conflicts.values()].at(0);
        if (!firstConflict) throw new Error("expected one pending conflict");
        const args = firstConflict.args;
        expect(Object.keys(args.p_incoming as object).sort()).toEqual(
          ["adjustment_id", "currency", "event_type", "occurred_at", "refund_id", "sale_id", "total_cents"],
        );
        expect(args).toMatchObject({
          p_provider: "paddle",
          p_event_type: "refund",
          p_adjustment_id: "adj_normalized",
          p_conflicting_sale_id: "sale_OTHER",
          p_conflicting_amount_cents: 1250,
          p_conflicting_currency: "EUR",
        });
        expect(args.p_payload_sha256).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        cleanup23505();
      }
    });

    it("a different payload under the same adjustment id is a SECOND inbox row", async () => {
      race23505();
      supa.adjLookupResult = conflicts("sale_OTHER", 12.5, "EUR");
      try {
        await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_two_payloads"))]);
        await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({ ...cbRefund("adj_two_payloads"), refundId: "rf_other" } as never)]);
        expect(supa.conflicts.size).toBe(2);
      } finally {
        cleanup23505();
      }
    });

    it("refund: mismatch but the inbox write fails -> 503 retryable, never 200", async () => {
      race23505();
      supa.adjLookupResult = conflicts("sale_OTHER");
      supa.rpcError = { message: "rpc down" };
      try {
        await expect(
          processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_rpc_down"))]),
        ).rejects.toSatisfy((e: unknown) => {
          expect503Collision(e);
          expect((e as Error).name).toBe("AdjustmentIdCollisionRecordError");
          return true;
        });
        expect(supa.conflicts.size).toBe(0);
        expect(supa.auditInserts).toHaveLength(0);
      } finally {
        cleanup23505();
      }
    });

    it("collision flag without adjustment_id/event_type is rejected (would bypass the dedupe index)", async () => {
      const { flagRefundForManualReview } = await import("../../../../payments/src/ledger.ts");
      await expect(
        flagRefundForManualReview({
          reason: "adjustment_id_collision", provider: "paddle", sale_id: "s1", refund_id: null,
          refund_cents: 100, sale_cents: 100, creator_id: null, occurred_at: "2026-09-28T00:00:00.000Z",
        }),
      ).rejects.toThrow(/adjustment_id is required/);
    });

    it("refund: 23505 + missing conflicting row -> 503 retryable, no flag", async () => {
      race23505();
      supa.adjLookupResult = { data: null, error: null };
      try {
        await expect(
          processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_no_row"))]),
        ).rejects.toSatisfy((e: unknown) => {
          expect503Collision(e);
          return true;
        });
        expect(supa.auditInserts).toHaveLength(0);
      } finally {
        cleanup23505();
      }
    });

    it("refund: 23505 + lookup error -> 503 retryable, no flag (nothing to compare against)", async () => {
      race23505();
      supa.adjLookupResult = { data: null, error: { message: "db down" } };
      try {
        await expect(
          processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_lookup_err"))]),
        ).rejects.toSatisfy((e: unknown) => {
          expect503Collision(e);
          return true;
        });
        expect(supa.auditInserts).toHaveLength(0);
      } finally {
        cleanup23505();
      }
    });

    it("reversal: 23505 + matching conflicting row -> resolves 200", async () => {
      await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_rev_refund"))]);
      race23505();
      supa.adjLookupResult = conflicts();
      try {
        await expect(
          processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbReversal("adj_rev_match") as never)]),
        ).resolves.toBeUndefined();
        expect(supa.auditInserts).toHaveLength(0);
      } finally {
        cleanup23505();
      }
    });

    it("reversal: 23505 + conflicting row with a DIFFERENT sale_id -> 200 conflict_pending + inbox row + adjustment_id_collision flag", async () => {
      await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_rev_refund2"))]);
      race23505();
      supa.adjLookupResult = conflicts("sale_OTHER");
      try {
        expectConflictPending(await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbReversal("adj_rev_other_sale") as never)]));
        expect(supa.auditInserts).toHaveLength(1);
        expect(supa.auditInserts[0]).toMatchObject({
          event: "MANUAL_REVIEW_REQUIRED_REFUND",
          details: expect.objectContaining({ reason: "adjustment_id_collision" }),
        });
      } finally {
        cleanup23505();
      }
    });

    it("reversal: 23505 + conflicting row with a different amount -> 200 conflict_pending + inbox row", async () => {
      await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_rev_refund3"))]);
      race23505();
      supa.adjLookupResult = conflicts(CB_SALE.sale_id, 12.5);
      try {
        expectConflictPending(await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbReversal("adj_rev_other_amt") as never)]));
        expect(supa.auditInserts).toHaveLength(1);
        expect(supa.auditInserts[0]).toMatchObject({
          event: "MANUAL_REVIEW_REQUIRED_REFUND",
          details: expect.objectContaining({ reason: "adjustment_id_collision" }),
        });
      } finally {
        cleanup23505();
      }
    });

    it("reversal: 23505 + same sale/amount but different currency -> 200 conflict_pending + inbox row + collision flag", async () => {
      await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_rev_refund_cur"))]);
      race23505();
      supa.adjLookupResult = conflicts(CB_SALE.sale_id, 39, "EUR");
      try {
        expectConflictPending(await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbReversal("adj_rev_other_cur") as never)]));
        expect(supa.auditInserts).toHaveLength(1);
        expect(supa.auditInserts[0]).toMatchObject({
          event: "MANUAL_REVIEW_REQUIRED_REFUND",
          details: expect.objectContaining({ reason: "adjustment_id_collision" }),
        });
      } finally {
        cleanup23505();
      }
    });

    it("refund: 23505 + conflicting row with a NULL stored currency -> empty string treated as non-matching -> 200 conflict_pending", async () => {
      race23505();
      supa.adjLookupResult = conflicts();
      (supa.adjLookupResult.data as { currency: string | null }).currency = null;
      try {
        expectConflictPending(await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_null_currency"))]));
        expect(supa.auditInserts).toHaveLength(1);
        expect(supa.auditInserts[0]).toMatchObject({
          event: "MANUAL_REVIEW_REQUIRED_REFUND",
          details: expect.objectContaining({ reason: "adjustment_id_collision", sale_id: CB_SALE.sale_id }),
        });
      } finally {
        cleanup23505();
      }
    });

    it("reversal: 23505 + conflicting row with a NULL stored currency -> empty string treated as non-matching -> 200 conflict_pending", async () => {
      await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_rev_nullc_refund"))]);
      race23505();
      supa.adjLookupResult = conflicts();
      (supa.adjLookupResult.data as { currency: string | null }).currency = null;
      try {
        expectConflictPending(await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbReversal("adj_rev_nullc") as never)]));
        expect(supa.auditInserts).toHaveLength(1);
        expect(supa.auditInserts[0]).toMatchObject({
          event: "MANUAL_REVIEW_REQUIRED_REFUND",
          details: expect.objectContaining({ reason: "adjustment_id_collision" }),
        });
      } finally {
        cleanup23505();
      }
    });

    it("reversal: 23505 + lookup error -> 503 retryable, no flag", async () => {
      await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_rev_refund4"))]);
      race23505();
      supa.adjLookupResult = { data: null, error: { message: "db down" } };
      try {
        await expect(
          processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbReversal("adj_rev_lookup_err") as never)]),
        ).rejects.toSatisfy((e: unknown) => {
          expect503Collision(e);
          return true;
        });
        expect(supa.auditInserts).toHaveLength(0);
      } finally {
        cleanup23505();
      }
    });
  });
});

// End-to-end through the real legacy wrapper and the real Fungies parser (audit R01): the live
// Fungies route must book the sale and hand delivery the buyer's email, not refuse it with 422.
describe("legacy-wrapped Fungies sale end-to-end (audit R01)", () => {
  const E2E_SECRET = randomBytes(16).toString("hex"); // per run: nothing credential-shaped is committed
  beforeEach(() => {
    setnx.mockReset();
    mockFenceSeq = 0;
    setnx.mockResolvedValue(1);
    delivery.deliverSaleForWebhook.mockClear();
    mkdirSync(salesFileDir, { recursive: true });
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
    vi.stubEnv("FUNGIES_WEBHOOK_SECRET", E2E_SECRET);
  });
  afterEach(() => {
    rmSync(salesFileDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function signedFungiesSale(): { headers: Record<string, string>; body: string } {
    const body = JSON.stringify({
      id: "evt_e2e",
      type: "payment_success",
      testMode: false,
      data: {
        items: [{ customFields: { product_id: "p1", attribution_id: "yt:e2e" } }],
        payment: { id: "pay_e2e", value: 3900, currency: "USD", currencyDecimals: 2, createdAt: 1759000000000 },
        user: { email: "buyer@example.com" },
      },
    });
    const sig = createHmac("sha256", E2E_SECRET).update(Buffer.from(body, "utf8")).digest("hex");
    return { headers: { "x-fngs-signature": `sha256_${sig}` }, body };
  }

  it("signed Fungies sale → $39 booked with attribution, delivery called with the buyer email", async () => {
    await processBillingWebhookUseCase(signedFungiesSale(), [new LegacyPaymentAdapterWrapper(fungiesProvider)]);
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean).map((r) => JSON.parse(r));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sale_id: "pay_e2e", provider: "fungies", amount_usd: 39, currency: "USD", attribution_id: "yt:e2e" });
    expect(JSON.stringify(rows[0])).not.toContain("buyer@example.com"); // raw email never persisted
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledWith({ saleId: "pay_e2e", productAlias: "p1", buyerEmail: "buyer@example.com", provider: "fungies", fence: expect.any(Number) });
  });
});

// Audit R04: a FastSpring POST may carry several events. Every one must be booked; the wrapper
// used to forward only the first and answer 200, losing the rest for good.
describe("multi-event delivery end-to-end (audit R04)", () => {
  const FS_SECRET = randomBytes(16).toString("hex");
  beforeEach(() => {
    setnx.mockReset();
    mockFenceSeq = 0;
    setnx.mockResolvedValue(1);
    delivery.deliverSaleForWebhook.mockClear();
    mkdirSync(salesFileDir, { recursive: true });
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
    vi.stubEnv("FASTSPRING_WEBHOOK_SECRET", FS_SECRET);
  });
  afterEach(() => {
    rmSync(salesFileDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("signed FastSpring POST with two orders → both sales booked and both buyers delivered", async () => {
    const order = (id: string, total: number, email: string) => ({
      id: `evt_${id}`, type: "order.completed", created: 1759000000000,
      data: { live: true, id, total, currency: "USD", customer: { email }, items: [{ product: "p1" }] },
    });
    const body = JSON.stringify({ events: [order("ord_a", 29, "a@example.com"), order("ord_b", 39, "b@example.com")] });
    const sig = createHmac("sha256", FS_SECRET).update(Buffer.from(body, "utf8")).digest("base64");
    await processBillingWebhookUseCase({ headers: { "x-fs-signature": sig }, body }, [new LegacyPaymentAdapterWrapper(fastspringProvider)]);
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean).map((r) => JSON.parse(r));
    expect(rows.map((r) => [r.sale_id, r.amount_usd])).toEqual([["ord_a", 29], ["ord_b", 39]]);
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledTimes(2);
    expect(delivery.deliverSaleForWebhook).toHaveBeenLastCalledWith({ saleId: "ord_b", productAlias: "p1", buyerEmail: "b@example.com", provider: "fastspring", fence: expect.any(Number) });
  });

  // F1: a failed event must not stop its siblings. A terminal (4xx) failure is final for the provider,
  // so any sale after it would never be booked; a retryable failure makes the whole delivery retry.
  const batchAdapter = (events: (SaleCompletedEvent | RefundIssuedEvent)[]): PaymentProviderPort =>
    ({
      providerName: "fastspring",
      canHandleWebhook: () => true,
      parseAndValidateWebhook: async () => ({ isValid: true, event: events[0], followingEvents: events.slice(1) }),
      createCheckout: undefined as never,
    }) as unknown as PaymentProviderPort;
  const fsSale = (saleId: string, totalCents: number, extra: Partial<SaleCompletedEvent> = {}): SaleCompletedEvent => ({
    ...SALE, providerName: "fastspring", saleId, totalCents, buyerEmail: `${saleId}@example.com`, ...extra,
  });
  const bookedRows = (): [string, number][] =>
    readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean).map((r) => JSON.parse(r)).map((r) => [r.sale_id, r.amount_usd]);

  it("[valid, invalid, valid] → both valid sales booked and delivered; the invalid one is reported as a final 422", async () => {
    const run = processBillingWebhookUseCase({ headers: {}, body: "" }, [
      batchAdapter([fsSale("ord_a", 2900), fsSale("ord_b", 3900, { currency: "EUR" }), fsSale("ord_c", 3900)]),
    ]);
    await expect(run).rejects.toMatchObject({ name: "WebhookValidationError", httpStatus: 422, message: expect.stringContaining("ord_b") });
    expect(bookedRows()).toEqual([["ord_a", 29], ["ord_c", 39]]);
    expect(delivery.deliverSaleForWebhook.mock.calls.map((c) => (c[0] as { saleId: string }).saleId)).toEqual(["ord_a", "ord_c"]);
  });

  it("one transient failure → the delivery is retryable; the retry books the missing sale and nothing twice", async () => {
    // ord_b's lock is held by another in-flight delivery on the first attempt only.
    setnx.mockImplementation(async (key: unknown) => (String(key).includes("ord_b") ? 0 : 1));
    const events = [fsSale("ord_a", 2900), fsSale("ord_b", 3900), fsSale("ord_c", 1900)];
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [batchAdapter(events)])).rejects.toMatchObject({ name: "WebhookInFlightError" });
    expect(bookedRows()).toEqual([["ord_a", 29], ["ord_c", 19]]);

    setnx.mockReset();
    setnx.mockResolvedValue(1);
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [batchAdapter(events)])).resolves.toBeUndefined();
    expect(bookedRows()).toEqual([["ord_a", 29], ["ord_c", 19], ["ord_b", 39]]);
  });

  it("a retryable failure outranks a terminal one in the same delivery: the provider must retry", async () => {
    setnx.mockImplementation(async (key: unknown) => (String(key).includes("ord_c") ? 0 : 1));
    const run = processBillingWebhookUseCase({ headers: {}, body: "" }, [
      batchAdapter([fsSale("ord_a", 2900, { currency: "EUR" }), fsSale("ord_b", 3900), fsSale("ord_c", 1900)]),
    ]);
    await expect(run).rejects.toMatchObject({ name: "WebhookInFlightError" });
    expect(bookedRows()).toEqual([["ord_b", 39]]);
  });

  it("an unexpected throw (unknown product) is retryable and does not stop the next sale", async () => {
    const run = processBillingWebhookUseCase({ headers: {}, body: "" }, [
      batchAdapter([fsSale("ord_x", 2900, { productId: "no_such_product" }), fsSale("ord_y", 3900)]),
    ]);
    await expect(run).rejects.toThrow(/Unknown product_id/);
    expect(bookedRows()).toEqual([["ord_y", 39]]);
  });
});

// F-09: the provider's mode must equal the product's checkout_mode. F-14: a contended lock is acknowledged only when the
// sale is recorded AND its receipt is confirmed sent.
describe("sale mode gate (F-09) and contended-lock confirmation (F-14)", () => {
  const booked = (): string[] => {
    try {
      return readFileSync(salesFilePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { sale_id: string }).sale_id);
    } catch {
      return []; // no ledger file: nothing booked
    }
  };
  const RECORD: SaleRecord = {
    ts: "2026-09-27T00:00:00.000Z",
    sale_id: "sale_recorded_1",
    provider: "polar",
    product_id: "p1",
    amount_usd: 39,
    creator_id: "c1",
    creator_split_pct: 50,
    creator_split_usd: 19.5,
    our_split_usd: 19.5,
    currency: "USD",
  };

  beforeEach(() => {
    setnx.mockReset().mockResolvedValue(1);
    delivery.deliverSaleForWebhook.mockClear();
    delivery.saleDeliveryConfirmed.mockReset().mockResolvedValue(false);
    mkdirSync(salesFileDir, { recursive: true });
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
  });
  afterEach(() => {
    rmSync(salesFileDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const run = (event: SaleCompletedEvent) => processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(event)]);
  async function refusal(event: SaleCompletedEvent): Promise<WebhookValidationError> {
    const err = await run(event).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookValidationError);
    return err as WebhookValidationError;
  }

  it("a live sale on a live product is booked and delivered", async () => {
    await run({ ...SALE, saleId: "sale_mode_ok", providerMode: "live" });
    expect(booked()).toEqual(["sale_mode_ok"]);
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledTimes(1);
  });

  it("a sandbox sale on a sandbox product is booked (the mode matches)", async () => {
    await run({ ...SALE, saleId: "sale_sbx_ok", productId: "p_sandbox", providerMode: "sandbox" });
    expect(booked()).toEqual(["sale_sbx_ok"]);
  });

  it("a sandbox (test-mode) event on a live product is refused: 422 SALE_MODE_MISMATCH, no row, no link", async () => {
    const err = await refusal({ ...SALE, saleId: "sale_test_on_live", providerMode: "sandbox" });
    expect(err.httpStatus).toBe(422);
    expect(err.name).toBe("SALE_MODE_MISMATCH");
    expect(booked()).toEqual([]);
    expect(delivery.deliverSaleForWebhook).not.toHaveBeenCalled();
  });

  it("a live event on a sandbox product is refused: 422 SALE_MODE_MISMATCH, no row, no link", async () => {
    const err = await refusal({ ...SALE, saleId: "sale_live_on_sbx", productId: "p_sandbox", providerMode: "live" });
    expect(err.name).toBe("SALE_MODE_MISMATCH");
    expect(booked()).toEqual([]);
    expect(delivery.deliverSaleForWebhook).not.toHaveBeenCalled();
  });

  it("a live event on a gated product (not open for sale) is refused: 422 SALE_MODE_MISMATCH", async () => {
    const err = await refusal({ ...SALE, saleId: "sale_gated", productId: "p_gated", providerMode: "live" });
    expect(err.name).toBe("SALE_MODE_MISMATCH");
    expect(booked()).toEqual([]);
    expect(delivery.deliverSaleForWebhook).not.toHaveBeenCalled();
  });

  it("an event with no provider mode is refused (fail closed): 422 SALE_MODE_UNKNOWN, no row, no link", async () => {
    const err = await refusal({ ...SALE, saleId: "sale_no_mode", providerMode: undefined });
    expect(err.httpStatus).toBe(422);
    expect(err.name).toBe("SALE_MODE_UNKNOWN");
    expect(booked()).toEqual([]);
    expect(delivery.deliverSaleForWebhook).not.toHaveBeenCalled();
  });

  it("a contended lock on a sale that is recorded AND confirmed sent is acknowledged, with no second write or send", async () => {
    await appendSale({ ...RECORD, sale_id: "sale_contended_ok" }, salesFilePath);
    setnx.mockResolvedValue(0); // another delivery holds the lock
    delivery.saleDeliveryConfirmed.mockResolvedValue(true);
    await expect(run({ ...SALE, saleId: "sale_contended_ok", providerMode: "live" })).resolves.toBeUndefined();
    expect(booked()).toEqual(["sale_contended_ok"]);
    expect(delivery.deliverSaleForWebhook).not.toHaveBeenCalled();
  });

  it("a contended lock with a confirmed receipt but NO recorded sale is still in-flight (never acknowledged)", async () => {
    setnx.mockResolvedValue(0);
    delivery.saleDeliveryConfirmed.mockResolvedValue(true);
    await expect(run({ ...SALE, saleId: "sale_contended_unrecorded", providerMode: "live" })).rejects.toMatchObject({
      name: "WebhookInFlightError",
    });
    expect(booked()).toEqual([]);
  });
});

// Mirror-order contract: on a duplicate sale and on a first sale, the buyer's delivery runs BEFORE the local-file
// mirror, so a local-file fault can never block the buyer's email. A mirror failure still surfaces (500, provider
// retries), and on a duplicate the retry re-delivers nothing and writes the mirror exactly once.
describe("sale mirror order: delivery runs before the local mirror (mirror-order contract)", () => {
  const SALE_ROW = {
    provider: "polar", sale_id: "sale_dup_1", product_id: "p1", amount_usd: 39, creator_id: "c1",
    creator_split_pct: 50, creator_split_usd: 19.5, our_split_usd: 19.5, currency: "USD", event_type: "sale",
    occurred_at: "2026-09-27T00:00:00.000Z", email_hash: null, attribution_id: null, provider_adjustment_id: null,
  };
  // Send-once model of delivery's per-sale idempotency: the first call sends, later calls are no-ops ("duplicate").
  const sentSaleIds = new Set<string>();
  const run = () => processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(SALE)]);
  const localRows = () => {
    try {
      return readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  };

  beforeEach(() => {
    setnx.mockReset();
    setnx.mockResolvedValue(1);
    mockFenceSeq = 0;
    supa.lookupResult = { data: SALE_ROW, error: null }; // sale is durable in Supabase; the local file is missing it
    supa.adjLookupResult = null;
    supa.auditInserts = [];
    supa.conflicts.clear();
    supa.rpcError = null;
    supa.auditError = null;
    mirrorFault.fail = false;
    mirrorFault.calls = 0;
    localWriteFault.fail = false;
    sentSaleIds.clear();
    mkdirSync(salesFileDir, { recursive: true });
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    delivery.deliverSaleForWebhook.mockClear();
    delivery.deliverSaleForWebhook.mockImplementation(async (input: unknown) => {
      const { saleId } = input as { saleId: string };
      if (!sentSaleIds.has(saleId)) sentSaleIds.add(saleId);
    });
    delivery.saleDeliveryConfirmed.mockResolvedValue(false);
  });

  afterEach(() => {
    mirrorFault.fail = false;
    localWriteFault.fail = false;
    delivery.deliverSaleForWebhook.mockImplementation(async () => undefined);
    rmSync(salesFileDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("(a) a duplicate sale whose local mirror throws still delivers the buyer email before the error surfaces", async () => {
    mirrorFault.fail = true;
    await expect(run()).rejects.toThrow("ENOSPC");
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledTimes(1);
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledWith({
      provider: "polar", saleId: "sale_dup_1", productAlias: "p1", buyerEmail: "buyer@example.com", fence: expect.any(Number),
    });
    expect(sentSaleIds).toEqual(new Set(["sale_dup_1"]));
    expect(mirrorFault.calls).toBe(1);
    expect(localRows()).toHaveLength(0);
  });

  it("(b) a mirror failure surfaces as a plain retryable error (no validation status, no in-flight 503), so the webhook answers 500", async () => {
    mirrorFault.fail = true;
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WebhookValidationError);
    expect((err as Error).name).not.toBe("WebhookInFlightError");
    expect((err as { httpStatus?: unknown }).httpStatus).toBeUndefined();
    expect((err as Error).message).toContain("ENOSPC");
  });

  it("(c) on retry with the mirror healthy: no second send, and the local mirror is written exactly once", async () => {
    mirrorFault.fail = true;
    await expect(run()).rejects.toThrow("ENOSPC"); // attempt 1: send happens, mirror fails
    mirrorFault.fail = false;
    await expect(run()).resolves.toBeUndefined(); // attempt 2 (provider retry): duplicate path, mirror healthy
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledTimes(2); // delivery re-attempted, idempotent per sale
    expect(sentSaleIds).toEqual(new Set(["sale_dup_1"])); // exactly one send across both attempts
    expect(mirrorFault.calls).toBe(2);
    const rows = localRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows.at(0) ?? "null")).toMatchObject({ provider: "polar", sale_id: "sale_dup_1" });
  });

  it("(d) a first sale whose local mirror write fails still delivers the buyer email before the error surfaces", async () => {
    supa.lookupResult = { data: null, error: null }; // first sale: not yet recorded in Supabase or locally
    localWriteFault.fail = true;
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({ ...SALE, saleId: "sale_first_1" })])).rejects.toThrow("ENOSPC");
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledTimes(1);
    expect(delivery.deliverSaleForWebhook).toHaveBeenCalledWith({
      provider: "polar", saleId: "sale_first_1", productAlias: "p1", buyerEmail: "buyer@example.com", fence: expect.any(Number),
    });
    expect(sentSaleIds).toEqual(new Set(["sale_first_1"]));
    expect(localRows()).toHaveLength(0);
  });
});

describe("F-05 duplicate identity checks on refund_issued and refund_reversed", () => {
  beforeEach(() => {
    setnx.mockReset();
    setnx.mockResolvedValue(1);
    mockFenceSeq = 0;
    mkdirSync(salesFileDir, { recursive: true });
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    supa.lookupResult = { data: null, error: null };
    supa.adjLookupResult = null;
    supa.auditInserts.length = 0;
    supa.collisionKeys.clear();
    supa.conflicts.clear();
    supa.upsertError = null;
    delivery.deliverSaleForWebhook.mockResolvedValue(undefined);
    delivery.saleDeliveryConfirmed.mockResolvedValue(false);
  });

  afterEach(() => {
    rmSync(salesFileDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const adapter = (event: unknown): PaymentProviderPort => ({
    providerName: "paddle",
    canHandleWebhook: () => true,
    parseAndValidateWebhook: async () => ({ isValid: true, event: event as never }),
    createCheckout: async () => {
      throw new Error("unused");
    },
  });

  it("refund_issued: existingRefund + cross-sale providerAdjustmentId collision -> 200 conflict_pending (never silent 200 duplicate)", async () => {
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "sale_completed", providerName: "paddle", saleId: "sale_f05_1", productId: "p1", totalCents: 3900, currency: "USD", buyerEmailHash: "h", occurredAt: "2026-11-18T00:00:00Z", providerMode: "live", rawPayload: null,
    })]);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "refund_issued", providerName: "paddle", saleId: "sale_f05_1", totalCents: 3900, currency: "USD", refundId: "adj_f05_1", providerAdjustmentId: "adj_f05_1", occurredAt: "2026-11-18T00:01:00Z", rawPayload: null,
    })]);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "sale_completed", providerName: "paddle", saleId: "sale_f05_2", productId: "p1", totalCents: 3900, currency: "USD", buyerEmailHash: "h", occurredAt: "2026-11-18T00:02:00Z", providerMode: "live", rawPayload: null,
    })]);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "refund_issued", providerName: "paddle", saleId: "sale_f05_2", totalCents: 3900, currency: "USD", refundId: "adj_f05_2", providerAdjustmentId: "adj_f05_2", occurredAt: "2026-11-18T00:03:00Z", rawPayload: null,
    })]);

    const res = await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "refund_issued", providerName: "paddle", saleId: "sale_f05_2", totalCents: 3900, currency: "USD", refundId: "adj_f05_1", providerAdjustmentId: "adj_f05_1", occurredAt: "2026-11-18T00:04:00Z", rawPayload: null,
    })]);
    expect(res).toMatchObject({ status: 200, payload: { reason: "conflict_pending", event_type: "refund", sale_id: "sale_f05_2" } });
    expect(supa.auditInserts).toHaveLength(1);
    expect(supa.auditInserts[0]).toMatchObject({
      event: "MANUAL_REVIEW_REQUIRED_REFUND",
      details: expect.objectContaining({ reason: "adjustment_id_collision", conflicting_sale_id: "sale_f05_1" }),
    });
  });

  it("refund_reversed: existingReversal with mismatched providerAdjustmentId or cross-sale collision -> 200 conflict_pending", async () => {
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "sale_completed", providerName: "paddle", saleId: "sale_rev_1", productId: "p1", totalCents: 3900, currency: "USD", buyerEmailHash: "h", occurredAt: "2026-11-18T00:00:00Z", providerMode: "live", rawPayload: null,
    })]);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "refund_issued", providerName: "paddle", saleId: "sale_rev_1", totalCents: 3900, currency: "USD", refundId: "adj_r1", providerAdjustmentId: "adj_r1", occurredAt: "2026-11-18T00:01:00Z", rawPayload: null,
    })]);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "refund_reversed", providerName: "paddle", saleId: "sale_rev_1", totalCents: 3900, currency: "USD", refundId: "adj_win_1", providerAdjustmentId: "adj_win_1", occurredAt: "2026-11-18T00:02:00Z", rawPayload: null,
    })]);

    // Same reversal adjustment_id -> clean 200 duplicate (void outcome) with no audit flag.
    const dup = await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "refund_reversed", providerName: "paddle", saleId: "sale_rev_1", totalCents: 3900, currency: "USD", refundId: "adj_win_1", providerAdjustmentId: "adj_win_1", occurredAt: "2026-11-18T00:02:30Z", rawPayload: null,
    })]);
    expect(dup).toBeUndefined();
    expect(supa.auditInserts).toHaveLength(0);

    // Different adjustment_id on the already-reversed sale -> recorded as conflict_pending.
    const diffAdj = await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "refund_reversed", providerName: "paddle", saleId: "sale_rev_1", totalCents: 3900, currency: "USD", refundId: "adj_win_2", providerAdjustmentId: "adj_win_2", occurredAt: "2026-11-18T00:03:00Z", rawPayload: null,
    })]);
    expect(diffAdj).toMatchObject({ status: 200, payload: { reason: "conflict_pending", event_type: "refund_reversal", sale_id: "sale_rev_1" } });
    expect(supa.auditInserts).toHaveLength(1);
    expect(supa.auditInserts[0]).toMatchObject({
      event: "MANUAL_REVIEW_REQUIRED_REFUND",
      details: expect.objectContaining({ reason: "adjustment_id_collision", adjustment_id: "adj_win_2" }),
    });
  });

  it("refund_reversed: contended lock does NOT acknowledge when amount or currency mismatches", async () => {
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "sale_completed", providerName: "paddle", saleId: "sale_rev_lock", productId: "p1", totalCents: 3900, currency: "USD", buyerEmailHash: "h", occurredAt: "2026-11-18T00:00:00Z", providerMode: "live", rawPayload: null,
    })]);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "refund_issued", providerName: "paddle", saleId: "sale_rev_lock", totalCents: 3900, currency: "USD", refundId: "adj_rl1", providerAdjustmentId: "adj_rl1", occurredAt: "2026-11-18T00:01:00Z", rawPayload: null,
    })]);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
      eventType: "refund_reversed", providerName: "paddle", saleId: "sale_rev_lock", totalCents: 3900, currency: "USD", refundId: "adj_rl_win", providerAdjustmentId: "adj_rl_win", occurredAt: "2026-11-18T00:02:00Z", rawPayload: null,
    })]);

    // Simulate lock held by another worker.
    setnx.mockResolvedValueOnce(0);
    await expect(
      processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter({
        eventType: "refund_reversed", providerName: "paddle", saleId: "sale_rev_lock", totalCents: 1000, currency: "USD", refundId: "adj_rl_win", providerAdjustmentId: "adj_rl_win", occurredAt: "2026-11-18T00:03:00Z", rawPayload: null,
      })]),
    ).rejects.toThrow(/in flight/);
  });
});
