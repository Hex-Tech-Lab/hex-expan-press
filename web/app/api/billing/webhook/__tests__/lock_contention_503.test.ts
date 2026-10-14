// Redis lock contention, end to end through the real handler + real use case: another delivery holds the
// idempotency lock (setnx -> 0) and nothing is persisted yet, so the provider must be told to retry:
// 503 + Retry-After (registry value), one WEBHOOK_503_RETRYING audit row, zero ledger writes.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ upserts: [] as unknown[], audits: [] as { table: string; row: { event?: string; details?: Record<string, unknown> } }[] }));
const ledgerDir = vi.hoisted(() => `${process.env.TMPDIR ?? "/tmp"}/lock-503-ledger-${globalThis.crypto.randomUUID()}`);

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      upsert: async (row: unknown) => { db.upserts.push(row); return { error: null }; },
      insert: (row: unknown) => {
        db.audits.push({ table, row: row as { event?: string; details?: Record<string, unknown> } });
        const result = Promise.resolve({ error: null });
        return Object.assign(result, { abortSignal: () => result });
      },
      select: () => ({ eq: function eq() { return { eq, in: eq, maybeSingle: async () => ({ data: null, error: null }) }; } }),
    }),
  }),
}));
vi.mock("../../../../../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../../src/infrastructure/redis/redis.client.ts")>()),
  expanRedis: { setnx: async () => 0, del: async () => 1 }, // the lock is already held
}));
vi.mock("../../../../../../payments/src/webhook_core.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../../payments/src/webhook_core.ts")>()),
  resolveProductByAlias: (alias: string) =>
    alias === "p1" ? Promise.resolve({ productId: "p1", creatorHandle: "c1", currency: "USD" }) : Promise.resolve(null),
}));
vi.mock("../../../../../../payments/src/terms.ts", () => ({
  effectiveCreatorSplitPct: () => 50,
  effectiveCreatorSplitPctAsync: () => Promise.resolve(50),
}));
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

const saleAdapter = {
  providerName: "paddle",
  canHandleWebhook: () => true,
  parseAndValidateWebhook: async () => ({
    isValid: true,
    event: { eventType: "sale_completed", providerName: "paddle", saleId: "txn_locked", productId: "p1", totalCents: 3900, currency: "USD", buyerEmailHash: "0xabc", occurredAt: "2026-10-04T00:00:00.000Z", rawPayload: null },
  }),
};
const POST = createWebhookHandler(() => [saleAdapter as never]);
const call = () =>
  POST(new Request("https://expanpress.com/api/billing/webhook", {
    method: "POST",
    headers: { "paddle-signature": "ts=1;h1=x" },
    body: JSON.stringify({ data: { id: "evt_1", transaction_id: "txn_locked" } }),
  }) as unknown as NextRequest);

describe("billing webhook: idempotency lock contention (setnx -> 0), real use case", () => {
  beforeEach(() => {
    db.upserts = []; db.audits = [];
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(ledgerDir, { recursive: true, force: true }); });

  it("answers 503 + Retry-After: 30, writes one WEBHOOK_503_RETRYING row, persists nothing", async () => {
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    const rows = db.audits.filter((a) => a.table === "audit_log" && a.row.event === "WEBHOOK_503_RETRYING");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row.details).toEqual({ provider: "paddle", sale_id: "txn_locked", reason: "idempotency_lock_in_flight" });
    expect(db.upserts).toHaveLength(0);
    expect(existsSync(`${ledgerDir}/sales.jsonl`)).toBe(false);
  });
});
