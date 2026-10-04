// D6 (hostile audit 2026-10-04): a VALID provider signature carrying a payload the ledger contract rejects
// (sub-cent amount) must pass signature validation, fail at the Zod gate with a 500, and write nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ upserts: [] as unknown[], audits: [] as unknown[] }));
const ledgerDir = vi.hoisted(() => `/tmp/d6-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`);

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      upsert: async (row: unknown) => { db.upserts.push(row); return { error: null }; },
      insert: async (row: unknown) => { db.audits.push({ table, row }); return { error: null }; },
      select: () => ({ eq: function eq() { return { eq, in: eq, maybeSingle: async () => ({ data: null, error: null }) }; } }),
    }),
  }),
}));
vi.mock("../../../../../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../../src/infrastructure/redis/redis.client.ts")>()),
  expanRedis: { setnx: async () => 1, del: async () => 1 },
}));
vi.mock("../../../../../../payments/src/webhook_core.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../../payments/src/webhook_core.ts")>()),
  loadProductIndex: () => new Map([["p1", { product_id: "p1", creator_id: "c1", currency: "USD" }]]),
}));
vi.mock("../../../../../../payments/src/terms.ts", () => ({ effectiveCreatorSplitPct: () => 50 }));
vi.mock("../../../../../../payments/src/settings_registry.ts", () => ({
  GLOBAL: {
    paths: { sales_ledger: `${ledgerDir}/sales.jsonl` },
    defaults: { currency: "USD" },
    payments: { webhook_tolerance_seconds: 300, webhook_lock_ttl_seconds: 300, http_timeout_ms: 5000, sync_http_timeout_ms: 30000, retry_after_seconds: 30 },
  },
  expandHome: (p: string) => p,
  isRegisteredPaymentProvider: (name: unknown) => typeof name === "string",
  paymentProviderSetting: () => undefined,
  isMoneyPath: () => false,
}));

import { createWebhookHandler } from "../handler";

const SECRET = "d6-test-secret";
const sign = (body: string) => createHmac("sha256", SECRET).update(body, "utf8").digest("hex");

/** Fixture provider: really verifies an HMAC over the raw body, then maps it to a sale event. */
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
      event: { eventType: "sale_completed", providerName: "polar", saleId: p.id, productId: "p1", totalCents: p.totalCents, currency: "USD", buyerEmailHash: "0xabc", occurredAt: "2026-10-04T00:00:00.000Z", rawPayload: null },
    };
  },
};
const POST = createWebhookHandler(() => [signedFixtureAdapter as never]);

const call = (body: string, signature: string) =>
  POST(new Request("https://expanpress.com/api/billing/webhook", { method: "POST", body, headers: { "x-fixture-signature": signature } }) as unknown as NextRequest);

describe("billing webhook: valid signature + malformed ledger payload", () => {
  beforeEach(() => {
    db.upserts = []; db.audits = [];
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(ledgerDir, { recursive: true, force: true }); });

  it("control: a valid signed cent-exact sale is recorded (200, one upsert)", async () => {
    const body = JSON.stringify({ id: "sale_ok", totalCents: 3900 });
    const res = await call(body, sign(body));
    expect(res.status).toBe(200);
    expect(db.upserts).toHaveLength(1);
  });

  it("valid signature, sub-cent total (39.005) → 500, zero upserts, local ledger untouched", async () => {
    const body = JSON.stringify({ id: "sale_subcent", totalCents: 3900.5 });
    const res = await call(body, sign(body));
    expect(res.status).toBe(500); // not 401/400: the signature passed and the Zod gate rejected
    expect(db.upserts).toHaveLength(0);
    expect(existsSync(`${ledgerDir}/sales.jsonl`)).toBe(false);
  });

  it("tampered signature on the same payload → 401 before any ledger work", async () => {
    const body = JSON.stringify({ id: "sale_subcent", totalCents: 3900.5 });
    const res = await call(body, sign(body + "x"));
    expect(res.status).toBe(401);
    expect(db.upserts).toHaveLength(0);
  });
});
