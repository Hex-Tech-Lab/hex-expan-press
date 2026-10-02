// Regression tests for the billing webhook use case (Wave 6.2 P1): both the
// sale and refund paths must run under the distributed idempotency lock —
// an already-recorded event returns normally (no duplicate ledger writes, no
// double payout); a lock held by an unpersisted in-flight delivery is retryable (Wave 7).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { appendSale, SaleRecord } from "../../../../payments/src/ledger.ts";
import { processBillingWebhookUseCase } from "../process_billing_webhook.ts";
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
  auditInserts: [] as Record<string, unknown>[],
  auditError: null as unknown,
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
      const eq = () => ({ eq, maybeSingle: async () => supa.lookupResult });
      return { select: () => ({ eq }), upsert: async () => ({ error: null }) };
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
    payments: { webhook_tolerance_seconds: 300, webhook_lock_ttl_seconds: 300, http_timeout_ms: 5000, sync_http_timeout_ms: 30000, reversal_wait_hours: 24 },
  },
  expandHome: (p: string, home: string) => (home && (p === "~" || p.startsWith("~/")) ? p : p),
  isRegisteredPaymentProvider: (name: unknown) => typeof name === "string",
  paymentProviderSetting: () => undefined,
}));

import { GLOBAL as REGISTRY } from "../../../../payments/src/settings_registry.ts";
const GLOBAL_WAIT_HOURS = REGISTRY.payments.reversal_wait_hours;

describe("process_billing_webhook_use_case idempotency (Wave 6.2 P1)", () => {
  beforeEach(() => {
    setnx.mockReset();
    supa.lookupResult = { data: null, error: null };
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
    setnx.mockResolvedValueOnce(1).mockResolvedValue(0); // first refund acquires, duplicate is held
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

  it("Defect A: reversal with no refund retries (500, no flag) inside the wait window, then flags once and acks 200 after it", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "mock-secret-key";
    setnx.mockResolvedValue(1);

    // Sale exists, but refund does NOT exist
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

    // Fresh reversal: the refund may still land, so retry (plain Error -> 500) and write NO flag.
    await expect(
      processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(reversalEvent as never)]),
    ).rejects.toThrow("refund reversal waiting for sale/refund: sale_no_refund");
    expect(supa.auditInserts).toHaveLength(0);

    // Older than the registry window: the refund will not come -> flag once, ack 200.
    const stale = { ...reversalEvent, occurredAt: new Date(Date.now() - (GLOBAL_WAIT_HOURS + 1) * 3_600_000).toISOString() };
    await expect(
      processBillingWebhookUseCase({ headers: {}, body: "" }, [adapter(stale as never)]),
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
});
