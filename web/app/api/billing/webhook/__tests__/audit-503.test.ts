// WEBHOOK_503_RETRYING audit trail: every 503 writes one best-effort audit row
// (provider + sale id, error NAME only, never the message); a failed or throwing
// insert must never change the 503 the provider sees.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  signals: [] as AbortSignal[],
  insert: async (row: Record<string, unknown>): Promise<{ error: { message: string } | null }> => { h.inserts.push(row); return { error: null }; },
}));
vi.mock("../../../../../../src/use_cases/billing/process_billing_webhook", () => ({
  processBillingWebhookUseCase: vi.fn(async () => {
    const err = new Error("webhook in flight: lock lock:refund:paddle:txn_1 is held; buyer a@b.c");
    err.name = "WebhookInFlightError";
    throw err;
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => ({
        abortSignal: (signal: AbortSignal) => { h.signals.push(signal); return h.insert(row); },
      }),
    }),
  }),
}));

import { POST } from "../route";

const post = () =>
  POST(new Request("https://expanpress.com/api/billing/webhook", {
    method: "POST",
    headers: { "paddle-signature": "ts=1;h1=x" },
    body: JSON.stringify({ data: { id: "adj_1", transaction_id: "txn_1" } }),
  }) as unknown as NextRequest);

beforeEach(() => {
  h.inserts = [];
  h.signals = [];
  h.insert = async (row) => { h.inserts.push(row); return { error: null }; };
  vi.stubEnv("SUPABASE_URL", "http://supabase.test");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test");
});

describe("billing webhook — 503 audit trail", () => {
  it("writes one WEBHOOK_503_RETRYING row with provider and sale id, no error message", async () => {
    const res = await post();
    expect(res.status).toBe(503);
    expect(h.inserts).toEqual([
      { event: "WEBHOOK_503_RETRYING", details: { provider: "paddle", sale_id: "txn_1", reason: "idempotency_lock_in_flight" } },
    ]);
    expect(JSON.stringify(h.inserts)).not.toContain("a@b.c");
  });

  it("an insert error leaves the 503 unchanged", async () => {
    h.insert = async () => ({ error: { message: "db down" } });
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("a hung insert is abandoned after the registry timeout; the 503 still returns", async () => {
    vi.useFakeTimers();
    try {
      h.insert = () => new Promise(() => {}); // never settles
      const pending = post();
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await pending).status).toBe(503);
      expect(h.signals[0]?.aborted).toBe(true); // the stalled insert was cancelled
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing insert leaves the 503 unchanged", async () => {
    h.insert = async () => { throw new Error("network"); };
    expect((await post()).status).toBe(503);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
