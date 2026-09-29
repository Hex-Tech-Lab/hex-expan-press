// Regression tests for the billing webhook use case (Wave 6.2 P1): both the
// sale and refund paths must run under the distributed idempotency lock —
// a held lock or an already-recorded event returns normally (no duplicate
// ledger writes, no double payout).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

vi.mock("../../../../src/infrastructure/redis/redis.client.ts", () => ({
  expanRedis: {
    setnx: (...a: unknown[]) => setnx(...a),
    del: vi.fn(() => Promise.resolve(1)),
  },
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
  GLOBAL: { paths: { sales_ledger: salesFilePath } },
  expandHome: (p: string, home: string) => (home && (p === "~" || p.startsWith("~/")) ? p : p),
  isRegisteredPaymentProvider: (name: unknown) => typeof name === "string",
  paymentProviderSetting: () => undefined,
}));

describe("process_billing_webhook_use_case idempotency (Wave 6.2 P1)", () => {
  beforeEach(() => {
    setnx.mockReset();
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

  it("two concurrent duplicate sales → exactly 1 ledger row (lock mocked)", async () => {
    setnx.mockResolvedValueOnce(1).mockResolvedValue(0); // first acquires, duplicate is held
    const a = adapter(SALE);
    await Promise.all([
      processBillingWebhookUseCase({ headers: {}, body: "" }, [a]),
      processBillingWebhookUseCase({ headers: {}, body: "" }, [a]),
    ]);
    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(1);
    expect(setnx.mock.calls.length).toBeGreaterThan(0);
    expect(setnx.mock.calls[0]?.[0]).toBe("lock:sale:polar:sale_dup_1");
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
});
