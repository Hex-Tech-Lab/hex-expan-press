// Error classification is typed, never by message text. A transient failure whose message happens to contain
// "validation failed" must stay retryable (500): a 400 is terminal and the provider would stop retrying.
import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";
import { WebhookValidationError } from "../../../../../../src/domain/webhook/webhook_errors";

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: () => Object.assign(Promise.resolve({ error: null }), { abortSignal: () => Promise.resolve({ error: null }) }),
    }),
  }),
}));
vi.mock("../../../../../../payments/src/settings_registry.ts", () => ({
  GLOBAL: {
    paths: { sales_ledger: "/tmp/transient-classification-ledger/sales.jsonl" },
    defaults: { currency: "USD" },
    payments: { webhook_tolerance_seconds: 300, webhook_lock_ttl_seconds: 300, http_timeout_ms: 5000, sync_http_timeout_ms: 30000, retry_after_seconds: 30 },
  },
  expandHome: (p: string) => p,
  isRegisteredPaymentProvider: (name: unknown) => typeof name === "string",
  paymentProviderSetting: () => undefined,
  isMoneyPath: () => false,
}));

import { createWebhookHandler } from "../handler";

/** An adapter that claims the request and fails inside parsing with the given error. */
function handlerThrowing(err: Error) {
  const adapter = {
    providerName: "paddle",
    canHandleWebhook: () => true,
    parseAndValidateWebhook: async () => {
      throw err;
    },
    createCheckout: undefined as never,
  };
  return createWebhookHandler(() => [adapter as never]);
}

const headers = {
  "webhook-id": "msg_1",
  "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
  "webhook-signature": "v1,AAAA",
};
const call = (POST: ReturnType<typeof createWebhookHandler>) =>
  POST(new Request("https://expanpress.com/api/billing/webhook", { method: "POST", body: "{}", headers }) as unknown as NextRequest);

describe("billing webhook: error classification is typed, not by message text", () => {
  it("a transient error whose message contains 'validation failed' is retryable (500), not terminal 400", async () => {
    const res = await call(handlerThrowing(new Error("Webhook validation failed: supabase lookup timed out")));
    expect(res.status).toBe(500);
  });

  it("a plain error whose message contains 'No payment provider' is retryable (500), not terminal 400", async () => {
    const res = await call(handlerThrowing(new Error("No payment provider configured (cache cold)")));
    expect(res.status).toBe(500);
  });

  it("a typed WebhookValidationError stays a terminal 400", async () => {
    const res = await call(handlerThrowing(new WebhookValidationError("bad payload shape")));
    expect(res.status).toBe(400);
  });
});
