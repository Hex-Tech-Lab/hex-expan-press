// payments.webhook_total_budget_ms at the route. A receipt send that outlasts the request budget is answered 503 with
// Retry-After inside the budget, with the sale already booked. A fast receipt is answered 200. A held 503 audit cannot push
// the answer past the budget. The registry budget is set to a short test value so the test stays fast.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import type { NextRequest } from "next/server";

const { BUDGET_MS, SLOW_SEND_MS } = vi.hoisted(() => ({ BUDGET_MS: 300, SLOW_SEND_MS: 2000 }));
const db = vi.hoisted(() => ({ upserts: [] as unknown[], audits: [] as { table: string; row: unknown }[], hangAudit: false }));
const deliver = vi.hoisted(() => ({ fn: (() => Promise.resolve()) as (input?: unknown) => Promise<void> }));
const ledgerDir = vi.hoisted(() => `/tmp/budget-ledger-${Date.now()}-${crypto.randomUUID()}`);

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const makeUpdate = () => ({
        eq: () => makeUpdate(),
        lte: () => makeUpdate(),
        select: async () => ({ data: [] as unknown[], error: null }),
      });
      return {
        upsert: async (row: unknown) => {
          db.upserts.push(row);
          return { error: null };
        },
        update: () => makeUpdate(),
        insert: (row: unknown) => {
          db.audits.push({ table, row });
          const result: Promise<{ error: null }> = db.hangAudit && table === "audit_log" ? new Promise(() => {}) : Promise.resolve({ error: null });
          return Object.assign(result, { abortSignal: () => result });
        },
        select: () => ({ eq: function eq() { return { eq, in: eq, abortSignal() { return this; }, maybeSingle: async () => ({ data: null, error: null }) }; } }),
      };
    },
  }),
}));
vi.mock("../../../../../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../../src/infrastructure/redis/redis.client.ts")>()),
  expanRedis: { setnx: async () => 1, incr: async () => 1, compareAndDel: async () => 1, del: async () => 1 },
}));
vi.mock("../../../../../../payments/src/webhook_core.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../../payments/src/webhook_core.ts")>()),
  resolveProductByAlias: (alias: string) =>
    alias === "p1" ? Promise.resolve({ productId: "p1", creatorHandle: "c1", currency: "USD", checkoutMode: "live" }) : Promise.resolve(null),
}));
vi.mock("../../../../../../payments/src/terms.ts", () => ({
  effectiveCreatorSplitPct: () => 50,
  effectiveCreatorSplitPctAsync: () => Promise.resolve(50),
}));
// Only the receipt send is controlled here; the budget race itself runs in the real use case.
vi.mock("../../../../../../payments/src/delivery.ts", () => ({ setDeliveryFailureReporter: () => undefined,
  deliverSaleForWebhook: (input: unknown) => deliver.fn(input),
  saleDeliveryConfirmed: async () => false,
}));
vi.mock("../../../../../../payments/src/settings_registry.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../payments/src/settings_registry")>();
  return {
    ...actual,
    GLOBAL: {
      ...actual.GLOBAL,
      paths: { ...actual.GLOBAL.paths, sales_ledger: `${ledgerDir}/sales.jsonl` },
      payments: { ...actual.GLOBAL.payments, webhook_total_budget_ms: BUDGET_MS },
    },
    isRegisteredPaymentProvider: (name: unknown) => typeof name === "string",
    isEnabledPaymentProvider: (name: unknown) => typeof name === "string",
    isMoneyPath: () => false,
  };
});

import { createWebhookHandler } from "../handler";

const SECRET = "budget-test-secret";
const sign = (body: string) => createHmac("sha256", SECRET).update(body, "utf8").digest("hex");

/** Fixture provider: verifies an HMAC over the raw body, then maps it to a live sale for product p1. */
const signedFixtureAdapter = {
  providerName: "polar",
  canHandleWebhook: (h: Record<string, unknown>) => Boolean(h["x-fixture-signature"]),
  parseAndValidateWebhook: async (h: Record<string, unknown>, body: string) => {
    const got = Buffer.from(String(h["x-fixture-signature"] ?? ""), "hex");
    const want = Buffer.from(sign(body), "hex");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return { isValid: false, error: "bad signature", httpStatus: 401 };
    const p = JSON.parse(body) as { id: string; totalCents: number };
    return {
      isValid: true,
      event: { eventType: "sale_completed", providerName: "polar", saleId: p.id, productId: "p1", totalCents: p.totalCents, currency: "USD", buyerEmailHash: "0xabc", buyerEmail: "buyer@example.com", occurredAt: "2026-11-18T00:00:00.000Z", providerMode: "live", rawPayload: null },
    };
  },
};
const POST = createWebhookHandler(() => [signedFixtureAdapter as never]);

const call = (body: string) =>
  POST(new Request("https://expanpress.com/api/billing/webhook", { method: "POST", body, headers: { "x-fixture-signature": sign(body) } }) as unknown as NextRequest);

describe("webhook total budget (payments.webhook_total_budget_ms)", () => {
  beforeEach(() => {
    db.upserts = [];
    db.audits = [];
    db.hangAudit = false;
    deliver.fn = () => Promise.resolve();
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  it("a slow receipt send is answered 503 with Retry-After inside the budget, with the sale booked", async () => {
    deliver.fn = () => new Promise<void>((resolve) => setTimeout(resolve, SLOW_SEND_MS));
    const body = JSON.stringify({ id: "sale_slow", totalCents: 3900 });
    const started = Date.now();
    const res = await call(body);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(elapsed).toBeLessThan(BUDGET_MS + 400); // the send would take SLOW_SEND_MS; the answer does not wait for it
    expect(db.upserts).toHaveLength(1); // the sale write completed before delivery
  });

  it("the receipt send gets the remaining budget as its deadline", async () => {
    const seen: { deadlineAt?: number }[] = [];
    deliver.fn = (input) => {
      seen.push(input as { deadlineAt?: number });
      return Promise.resolve();
    };
    const started = Date.now();
    await call(JSON.stringify({ id: "sale_deadline", totalCents: 3900 }));
    expect(seen[0]?.deadlineAt).toBeGreaterThanOrEqual(started + BUDGET_MS);
    expect(seen[0]?.deadlineAt).toBeLessThanOrEqual(started + BUDGET_MS + 200);
  });

  it("a fast receipt send is answered 200", async () => {
    const res = await call(JSON.stringify({ id: "sale_fast", totalCents: 3900 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.upserts).toHaveLength(1);
  });

  it("a hung 503 audit cannot push the answer past the budget", async () => {
    db.hangAudit = true;
    deliver.fn = () => new Promise<void>((resolve) => setTimeout(resolve, SLOW_SEND_MS));
    const started = Date.now();
    const res = await call(JSON.stringify({ id: "sale_hung_audit", totalCents: 3900 }));
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS + 400);
  });

  it("the provider's retry is answered 200, and the receipt step runs again with a fresh deadline", async () => {
    const body = JSON.stringify({ id: "sale_retry", totalCents: 3900 });
    deliver.fn = () => new Promise<void>((resolve) => setTimeout(resolve, SLOW_SEND_MS));
    expect((await call(body)).status).toBe(503);
    const seen: { deadlineAt?: number }[] = [];
    deliver.fn = (input) => {
      seen.push(input as { deadlineAt?: number });
      return Promise.resolve();
    };
    const retryStarted = Date.now();
    const retry = await call(body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true });
    // The stateless Supabase mock does not model the sale lookup, so "booked once" is pinned by the delivery-layer test,
    // not here. This test pins the route's retry answer and the fresh budget.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.deadlineAt).toBeGreaterThanOrEqual(retryStarted + BUDGET_MS);
  });
});
