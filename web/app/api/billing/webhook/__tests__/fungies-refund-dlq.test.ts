// Wave 7.3: a SIGNED Fungies payment_refunded carries no refunded amount, so the
// engine must route it to manual review — through the REAL webhook route to a durable
// MANUAL_REVIEW_REQUIRED_REFUND audit row (reason "amount_unverifiable") and a 400,
// with NO refund row ever appended to the ledger.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { appendSale, SaleRecord } from "../../../../../../payments/src/ledger.ts";
import { POST as billingPost } from "../route";

const asNextRequest = (req: Request): NextRequest => req as unknown as NextRequest;

const HMAC_TEST_KEY = "wave73-fungies-refund-test-key";
const WEBHOOK_URL = "http://localhost:3000/api/billing/webhook";

function signedHeaders(payload: string) {
  const sig = crypto.createHmac("sha256", HMAC_TEST_KEY).update(Buffer.from(payload, "utf8")).digest("hex");
  return { "x-fngs-signature": `sha256_${sig}`, "content-type": "application/json" };
}

// Supabase is faked: orders lookups miss (so the sale comes from the ledger),
// audit_log inserts are captured for assertions.
const supa = vi.hoisted(() => ({
  lookupResult: { data: null as unknown, error: null as unknown },
  auditInserts: [] as Record<string, unknown>[],
  auditInsertError: null as { message: string } | null,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "audit_log") {
        return {
          insert: async (row: Record<string, unknown>) => {
            supa.auditInserts.push(row);
            return { error: supa.auditInsertError };
          },
          // flagRefundForManualReview upserts on idempotency_key (20261004001000)
          upsert: async (row: Record<string, unknown>) => {
            supa.auditInserts.push(row);
            return { error: supa.auditInsertError };
          },
        };
      }
      const eq = () => ({ eq, maybeSingle: async () => supa.lookupResult });
      return { select: () => ({ eq }), upsert: async () => ({ error: null }) };
    },
  }),
}));

// Distributed lock: first acquire wins (mirrors expanRedis SETNX under no contention).
const setnx = vi.fn<(...args: unknown[]) => Promise<number>>();
vi.mock("../../../../../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../../src/infrastructure/redis/redis.client.ts")>()),
  expanRedis: {
    setnx: (...a: unknown[]) => setnx(...a),
    del: vi.fn(() => Promise.resolve(1)),
  },
}));

// Deterministic product config for the use case.
vi.mock("../../../../../../payments/src/webhook_core.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../../../../payments/src/webhook_core.ts")>();
  return {
    ...orig,
    loadProductIndex: () =>
      new Map([["duane_retirement_playbook_v1", { product_id: "duane_retirement_playbook_v1", creator_id: "c1", currency: "USD" }]]),
  };
});

vi.mock("../../../../../../payments/src/terms.ts", () => ({
  effectiveCreatorSplitPct: () => 50,
}));

// Point the registry module at a temp ledger path — tests never touch data/db.
const salesFileDir = vi.hoisted(() => `/tmp/fungies-dlq-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const salesFilePath = vi.hoisted(() => `${salesFileDir}/sales.jsonl`);

vi.mock("../../../../../../payments/src/settings_registry.ts", () => ({
  GLOBAL: {
    paths: { sales_ledger: salesFilePath },
    payments: { webhook_tolerance_seconds: 300, webhook_lock_ttl_seconds: 300, http_timeout_ms: 5000, sync_http_timeout_ms: 30000 },
  },
  expandHome: (p: string, home: string) => (home && (p === "~" || p.startsWith("~/")) ? p : p),
  isRegisteredPaymentProvider: (name: unknown) => typeof name === "string",
  paymentProviderSetting: () => undefined,
  getPath: (obj: unknown, path: unknown) =>
    typeof path === "string"
      ? path.split(".").filter(Boolean).reduce<unknown>((acc, k) => (acc != null ? (acc as Record<string, unknown>)[k] : undefined), obj)
      : undefined,
}));

const BASE_SALE: SaleRecord = {
  ts: "2026-09-30T00:00:00.000Z",
  sale_id: "fng_sale_1",
  provider: "fungies",
  product_id: "duane_retirement_playbook_v1",
  amount_usd: 19,
  creator_id: "c1",
  creator_split_pct: 50,
  creator_split_usd: 9.5,
  our_split_usd: 9.5,
  currency: "USD",
};

function refundPayload(saleId: string) {
  return JSON.stringify({
    id: `evt-fng-${Math.random().toString(36).slice(2)}`,
    type: "payment_refunded",
    data: {
      items: [],
      order: { id: "ord_fng", createdAt: 1759000000000 },
      payment: { id: saleId, value: 1900, currency: "USD", currencyDecimals: 2, createdAt: 1759000000000 },
    },
  });
}

describe("fungies refund via real webhook route (amount_unverifiable → manual review)", () => {
  beforeEach(() => {
    setnx.mockReset();
    setnx.mockResolvedValue(1);
    supa.lookupResult = { data: null, error: null };
    supa.auditInserts = [];
    supa.auditInsertError = null;
    mkdirSync(salesFileDir, { recursive: true });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FUNGIES_WEBHOOK_SECRET", HMAC_TEST_KEY);
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
  });

  afterEach(() => {
    rmSync(salesFileDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("signed fungies refund → 400 + MANUAL_REVIEW_REQUIRED_REFUND (amount_unverifiable) + no ledger refund row", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    const payload = refundPayload("fng_sale_1");
    const res = await billingPost(
      asNextRequest(new Request(WEBHOOK_URL, { method: "POST", headers: signedHeaders(payload), body: payload })),
    );
    expect(res.status).toBe(400);

    expect(supa.auditInserts).toHaveLength(1);
    expect(supa.auditInserts[0]).toMatchObject({
      event: "MANUAL_REVIEW_REQUIRED_REFUND",
      details: {
        reason: "amount_unverifiable",
        provider: "fungies",
        sale_id: "fng_sale_1",
        refund_cents: null,
        sale_cents: 1900,
      },
    });

    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows.filter((r) => r.includes('"event_type":"refund"'))).toHaveLength(0);
    expect(rows).toHaveLength(1); // only the seeded sale remains
  });

  it("audit insert failure → 500 (provider retries, nothing recorded)", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    supa.auditInsertError = { message: "unit-test insert failure" };
    const payload = refundPayload("fng_sale_1");
    const res = await billingPost(
      asNextRequest(new Request(WEBHOOK_URL, { method: "POST", headers: signedHeaders(payload), body: payload })),
    );
    expect(res.status).toBe(500);
  });
});
