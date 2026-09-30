// Wave 7.3: a SIGNED Polar PARTIAL refund (amount + tax < original sale) must
// flow through the REAL webhook route to a durable MANUAL_REVIEW_REQUIRED_REFUND
// audit row (refund_cents = amount + tax_amount, sale_cents = recorded sale) and
// a 400 — with NO refund row ever appended to the ledger (refunds are
// full-reversal records; a partial must never be recorded as one).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { appendSale, SaleRecord } from "../../../../../../payments/src/ledger.ts";
import { POST as billingPost } from "../route";

const asNextRequest = (req: Request): NextRequest => req as unknown as NextRequest;

const HMAC_TEST_KEY = "wave73-partial-refund-test-key";
const WEBHOOK_URL = "http://localhost:3000/api/billing/webhook";

function signedHeaders(payload: string) {
  const id = "whid_partial_0001";
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", Buffer.from(HMAC_TEST_KEY, "utf8")).update(`${id}.${ts}.${payload}`).digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sig}`,
    "content-type": "application/json",
  };
}

// Supabase is faked: orders lookups miss (so the sale comes from the ledger),
// audit_log inserts are captured for assertions.
const supa = vi.hoisted(() => ({
  lookupResult: { data: null as unknown, error: null as unknown },
  auditInserts: [] as Record<string, unknown>[],
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "audit_log") {
        return {
          insert: async (row: Record<string, unknown>) => {
            supa.auditInserts.push(row);
            return { error: null };
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
const salesFileDir = vi.hoisted(() => `/tmp/polar-partial-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const salesFilePath = vi.hoisted(() => `${salesFileDir}/sales.jsonl`);

vi.mock("../../../../../../payments/src/settings_registry.ts", () => ({
  GLOBAL: { paths: { sales_ledger: salesFilePath } },
  expandHome: (p: string, home: string) => (home && (p === "~" || p.startsWith("~/")) ? p : p),
  isRegisteredPaymentProvider: (name: unknown) => typeof name === "string",
  paymentProviderSetting: () => undefined,
}));

const BASE_SALE: SaleRecord = {
  ts: "2026-09-29T00:00:00.000Z",
  sale_id: "ord_partial_1",
  provider: "polar",
  product_id: "duane_retirement_playbook_v1",
  amount_usd: 39,
  creator_id: "c1",
  creator_split_pct: 50,
  creator_split_usd: 19.5,
  our_split_usd: 19.5,
  currency: "USD",
};

describe("polar partial refund via real webhook route (Wave 7.3)", () => {
  beforeEach(() => {
    setnx.mockReset();
    setnx.mockResolvedValue(1);
    supa.lookupResult = { data: null, error: null };
    supa.auditInserts = [];
    mkdirSync(salesFileDir, { recursive: true });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLAR_WEBHOOK_SECRET", HMAC_TEST_KEY);
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
  });

  afterEach(() => {
    rmSync(salesFileDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("signed partial refund → 400 + MANUAL_REVIEW_REQUIRED_REFUND audit + no ledger refund row", async () => {
    await appendSale(BASE_SALE, salesFilePath);
    const payload = JSON.stringify({
      type: "refund.created",
      data: {
        id: "rf_p1",
        order_id: "ord_partial_1",
        amount: 1000,
        tax_amount: 100,
        created_at: "2026-09-30T00:00:00.000Z",
      },
    });
    const res = await billingPost(
      asNextRequest(new Request(WEBHOOK_URL, { method: "POST", headers: signedHeaders(payload), body: payload })),
    );
    expect(res.status).toBe(400);

    expect(supa.auditInserts).toHaveLength(1);
    expect(supa.auditInserts[0]).toMatchObject({
      event: "MANUAL_REVIEW_REQUIRED_REFUND",
      details: {
        provider: "polar",
        sale_id: "ord_partial_1",
        refund_id: "rf_p1",
        refund_cents: 1100,
        sale_cents: 3900,
      },
    });

    const rows = readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows.filter((r) => r.includes('"event_type":"refund"'))).toHaveLength(0);
    expect(rows).toHaveLength(1); // only the seeded sale remains
  });
});
