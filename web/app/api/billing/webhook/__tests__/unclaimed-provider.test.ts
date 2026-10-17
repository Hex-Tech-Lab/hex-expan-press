// A provider-shaped delivery that no routable adapter claims (e.g. a Polar order.paid sent after Polar was
// removed) must not vanish: the event is quarantined and audited for replay. A request with no provider
// signature headers at all stays unquarantined, so unauthenticated traffic cannot force audit writes (PR #78).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ terminalRejects: [] as { event?: string; details?: Record<string, unknown> }[] }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: (row: unknown) => {
        const r = row as { event?: string; details?: Record<string, unknown> };
        if (table === "audit_log" && r.event === "WEBHOOK_TERMINAL_REJECT") db.terminalRejects.push(r);
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

describe("billing webhook: provider-shaped delivery with no routable adapter", () => {
  beforeEach(() => {
    db.terminalRejects = [];
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
  });

  it("answers 400 and quarantines the event with a WEBHOOK_TERMINAL_REJECT audit row for replay", async () => {
    const res = await call(standardWebhookHeaders);
    expect(res.status).toBe(400);
    expect(db.terminalRejects).toHaveLength(1);
    expect(db.terminalRejects[0].details?.reason).toBe("WebhookValidationError");
  });

  it("does not quarantine a request that carries no provider signature headers", async () => {
    const res = await call({});
    expect(res.status).toBe(400);
    expect(db.terminalRejects).toHaveLength(0);
  });
});
