// A provider-shaped delivery that no routable adapter claims has no verifier, so the request is unauthenticated.
// It must not write any row: no audit_log insert, no quarantine. The event answers 400 and is logged only.
// The same holds for a request with no provider signature headers at all (PR #78: unauthenticated traffic must
// not force audit_log writes).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ writes: [] as { table: string; row: unknown }[] }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: (row: unknown) => {
        db.writes.push({ table, row });
        const insertResult = Promise.resolve({ error: null });
        return Object.assign(insertResult, { abortSignal: () => insertResult });
      },
    }),
  }),
}));
vi.mock("../../../../../../payments/src/settings_registry.ts", () => ({
  GLOBAL: {
    paths: { sales_ledger: "/tmp/unclaimed-provider-ledger/sales.jsonl" },
    defaults: { currency: "USD" },
    payments: { webhook_tolerance_seconds: 300, webhook_lock_ttl_seconds: 300, http_timeout_ms: 5000, sync_http_timeout_ms: 30000, retry_after_seconds: 30 },
  },
  expandHome: (p: string) => p,
  isRegisteredPaymentProvider: (name: unknown) => typeof name === "string",
  paymentProviderSetting: () => undefined,
  isMoneyPath: () => false,
}));

import { createWebhookHandler } from "../handler";

// No adapter is routable: nothing claims the signature headers.
const POST = createWebhookHandler(() => []);

const standardWebhookHeaders = {
  "webhook-id": "msg_1",
  "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
  "webhook-signature": "v1,AAAA",
};

const call = (headers: Record<string, string>) =>
  POST(new Request("https://expanpress.com/api/billing/webhook", { method: "POST", body: "{}", headers }) as unknown as NextRequest);

describe("billing webhook: unverified requests write nothing", () => {
  beforeEach(() => {
    db.writes = [];
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
  });

  it("a provider-shaped delivery with no routable adapter answers 400 and writes zero rows", async () => {
    const res = await call(standardWebhookHeaders);
    expect(res.status).toBe(400);
    expect(db.writes).toHaveLength(0);
  });

  it("a request with no provider signature headers answers 400 and writes zero rows", async () => {
    const res = await call({});
    expect(res.status).toBe(400);
    expect(db.writes).toHaveLength(0);
  });
});
