// Regression tests for the billing webhook use case (Wave 6.2 P1): both the
// sale and refund paths must run under the distributed idempotency lock —
// an already-recorded event returns normally (no duplicate ledger writes, no
// double payout); a lock held by an unpersisted in-flight delivery is retryable (Wave 7).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { appendSale, SaleRecord } from "../../../../payments/src/ledger.ts";
import { processBillingWebhookUseCase } from "../process_billing_webhook.ts";
import { WebhookValidationError } from "../../../../src/domain/webhook/webhook_errors.ts";
import type { PaymentProviderPort, SaleCompletedEvent, RefundIssuedEvent } from "../../../../src/domain/payments/payments.port.ts";

const SALE: SaleCompletedEvent = {
  eventType: "sale_completed",
  providerName: "polar",
  saleId: "sale_dup_1",
  productId: "p1",
  totalCents: 3900,
  currency: "USD",
  buyerEmailHash: "0xabc",
  occurredAt: "2026-09-28T00:00:00.000Z",
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

vi.mock("../../../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  // keep the real env helpers (redisRestEnv / isRedisRestConfigured) — only the client is faked
  ...(await importOriginal<typeof import("../../../../src/infrastructure/redis/redis.client.ts")>()),
  expanRedis: {
    setnx: (...a: unknown[]) => setnx(...a),
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
  auditError: null as unknown,
  upsertError: null as unknown,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "audit_log") {
        return {
          insert: async (row: Record<string, unknown>) => {
            supa.auditInserts.push(row);
            return { error: supa.auditError };
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
      return { select: () => ({ eq }), upsert: async () => ({ error: supa.upsertError }) };
    },
  }),
}));

// Deterministic product config so the use case resolves creator/split.
vi.mock("../../../../payments/src/webhook_core.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../../payments/src/webhook_core.ts")>();
  return {
    ...orig,
    loadProductIndex: () =>
      new Map([
        ["p1", { product_id: "p1", creator_id: "c1", currency: "USD" }],
      ]),
  };
});

vi.mock("../../../../payments/src/terms.ts", () => ({
  effectiveCreatorSplitPct: () => 50,
}));



// The use case writes through ledger SALES_FILE (settings registry global.json).
// Point the registry module at a temp ledger path so tests never touch data/db.
// Hoisted so the settings-registry factory below can read it at import time.
const salesFileDir = vi.hoisted(() => `/tmp/hook-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const salesFilePath = vi.hoisted(() => `${salesFileDir}/sales.jsonl`);

vi.mock("../../../../payments/src/settings_registry.ts", () => ({
  GLOBAL: {
    paths: { sales_ledger: salesFilePath },
    defaults: { currency: "USD" },
    payments: { webhook_tolerance_seconds: 300, webhook_lock_ttl_seconds: 300, http_timeout_ms: 5000, sync_http_timeout_ms: 30000 },
  },
  expandHome: (p: string, home: string) => (home && (p === "~" || p.startsWith("~/")) ? p : p),
  isRegisteredPaymentProvider: (name: unknown) => typeof name === "string",
  paymentProviderSetting: () => undefined,
  // F4 money-path predicate (mirrors settings_registry.isMoneyPath): the
  // fail-closed production guards read the same env signals as production.
  isMoneyPath: () =>
    process.env.NODE_ENV === "production" || process.env.VERCEL_ENV !== undefined || !!process.env.AWS_LAMBDA_FUNCTION_NAME,
}));

describe("process_billing_webhook_use_case idempotency (Wave 6.2 P1)", () => {
  beforeEach(() => {
    setnx.mockReset();
    supa.lookupResult = { data: null, error: null };
    supa.adjLookupResult = null;
    supa.auditInserts = [];
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

  it("lock held but the sale is already durably recorded → acknowledged (resolves), no re-write", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    setnx.mockResolvedValue(0);
    await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(SALE)]);
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(1);
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
    expect(setnx).toHaveBeenCalledWith("lock:sale:polar:sale_dup_1", "1", expect.anything());
  });

  it("production with no Redis configured → fails closed (throws), never processes unlocked", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(SALE)])).rejects.toThrow(
      /lock unavailable: Redis is not configured in production/,
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
    expect(setnx).toHaveBeenCalledWith("lock:sale:polar:sale_dup_1", "1", expect.anything());
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
    expect(JSON.parse(rows[1]!)).toMatchObject({ event_type: "refund", provider_adjustment_id: "adj_abc" });

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

    it("refund: 23505 + conflicting row with a DIFFERENT sale_id -> 503 retryable + adjustment_id_collision flag", async () => {
      race23505();
      supa.adjLookupResult = conflicts("sale_OTHER");
      try {
        await expect(
          processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_other_sale"))]),
        ).rejects.toSatisfy((e: unknown) => {
          expect503Collision(e);
          return true;
        });
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

    it("refund: 23505 + conflicting row with a different amount -> 503 retryable", async () => {
      race23505();
      supa.adjLookupResult = conflicts(CB_SALE.sale_id, 12.5);
      try {
        await expect(
          processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_other_amt"))]),
        ).rejects.toSatisfy((e: unknown) => {
          expect503Collision(e);
          return true;
        });
        expect(supa.auditInserts).toHaveLength(1);
        expect(supa.auditInserts[0]).toMatchObject({
          event: "MANUAL_REVIEW_REQUIRED_REFUND",
          details: expect.objectContaining({ reason: "adjustment_id_collision" }),
        });
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

    it("reversal: 23505 + conflicting row with a DIFFERENT sale_id -> 503 retryable + adjustment_id_collision flag", async () => {
      await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_rev_refund2"))]);
      race23505();
      supa.adjLookupResult = conflicts("sale_OTHER");
      try {
        await expect(
          processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbReversal("adj_rev_other_sale") as never)]),
        ).rejects.toSatisfy((e: unknown) => {
          expect503Collision(e);
          return true;
        });
        expect(supa.auditInserts).toHaveLength(1);
        expect(supa.auditInserts[0]).toMatchObject({
          event: "MANUAL_REVIEW_REQUIRED_REFUND",
          details: expect.objectContaining({ reason: "adjustment_id_collision" }),
        });
      } finally {
        cleanup23505();
      }
    });

    it("reversal: 23505 + conflicting row with a different amount -> 503 retryable", async () => {
      await processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbRefund("adj_rev_refund3"))]);
      race23505();
      supa.adjLookupResult = conflicts(CB_SALE.sale_id, 12.5);
      try {
        await expect(
          processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(cbReversal("adj_rev_other_amt") as never)]),
        ).rejects.toSatisfy((e: unknown) => {
          expect503Collision(e);
          return true;
        });
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

  // ------------------------------------------------------------------
  // Sprint-10 F5: typed WebhookValidationError replaces prose-based
  // classification. Routes classify on instanceof (a deprecated substring
  // fallback remains one release); these tests pin the typed contract.
  // ------------------------------------------------------------------
  describe("typed validation errors (F5)", () => {
    const failingAdapter = (result: { isValid: false; error: string; httpStatus?: number }): PaymentProviderPort =>
      ({
        providerName: "polar",
        canHandleWebhook: () => true,
        parseAndValidateWebhook: () => Promise.resolve(result),
        createCheckout: undefined as never,
      }) as unknown as PaymentProviderPort;

    it("no matching provider → typed WebhookValidationError with default httpStatus 400", async () => {
      const rejection = processBillingWebhookUseCase({ headers: {}, body: "" }, []);
      await expect(rejection).rejects.toBeInstanceOf(WebhookValidationError);
      await expect(rejection).rejects.toMatchObject({ name: "WebhookValidationError", httpStatus: 400 });
    });

    it("adapter parse failure → typed WebhookValidationError carrying the adapter's httpStatus hint", async () => {
      await expect(
        processBillingWebhookUseCase({ headers: {}, body: "" }, [
          failingAdapter({ isValid: false, error: "stale signature", httpStatus: 401 }),
        ]),
      ).rejects.toMatchObject({ name: "WebhookValidationError", httpStatus: 401 });
    });

    it("a REWORDED validation failure is still typed — instanceof wins even without the 'validation failed' prose", async () => {
      // Message deliberately contains neither "validation failed" nor
      // "No payment provider": classification must survive any rewording.
      await expect(
        processBillingWebhookUseCase({ headers: {}, body: "" }, [
          failingAdapter({ isValid: false, error: "signature unverifiable for this delivery" }),
        ]),
      ).rejects.toBeInstanceOf(WebhookValidationError);
    });

    it("a plain infra Error mentioning validation is NOT typed (no substring false-positive → route 500s)", async () => {
      const adapterThrowsPlain: PaymentProviderPort = {
        providerName: "polar",
        canHandleWebhook: () => true,
        parseAndValidateWebhook: () => Promise.reject(new Error("validation subsystem unavailable")),
        createCheckout: undefined as never,
      } as unknown as PaymentProviderPort;
      const rejection = processBillingWebhookUseCase({ headers: {}, body: "" }, [adapterThrowsPlain]);
      await expect(rejection).rejects.toThrow(/validation subsystem unavailable/);
      await rejection.catch((err: unknown) => {
        expect(err).not.toBeInstanceOf(WebhookValidationError);
      });
    });

    it("unknown product_id stays a plain infra error (500 → provider retries), not typed validation", async () => {
      setnx.mockResolvedValue(1);
      const unknownProduct: SaleCompletedEvent = { ...SALE, saleId: "sale_unknown_product", productId: "nope" };
      const rejection = processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(unknownProduct)]);
      await expect(rejection).rejects.toThrow(/Unknown product_id: nope/);
      await rejection.catch((err: unknown) => {
        expect(err).not.toBeInstanceOf(WebhookValidationError);
      });
    });
  });
});
