// Route-level HTTP contract for use-case outcomes (Wave 7 / 7.2):
//  - lock held by an unpersisted in-flight delivery → 503 + Retry-After (provider
//    retries) — never 200, the holder may still fail and the sale would be lost;
//  - mismatched refund (flagged to the audit log) → 400 "Bad Request";
//  - dead-letter/infra failure → 500 (retryable).
import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

const useCase = vi.hoisted(() => ({ error: null as Error | null, outcome: undefined as unknown }));
vi.mock("../../../../../../src/use_cases/billing/process_billing_webhook", () => ({
  processBillingWebhookUseCase: vi.fn(async () => {
    if (useCase.error) throw useCase.error;
    return useCase.outcome;
  }),
}));

import { POST } from "../route";

const post = () =>
  POST(new Request("https://expanpress.com/api/billing/webhook", { method: "POST", body: "{}" }) as unknown as NextRequest);

describe("billing webhook — HTTP status contract (Wave 7 / 7.2)", () => {
  it("in-flight lock contention → 503 with Retry-After, not 200", async () => {
    const err = new Error("webhook in flight: lock lock:sale:polar:s1 is held by another delivery");
    err.name = "WebhookInFlightError";
    useCase.error = err;
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("mismatched refund (flagged for manual review) → 400 Bad Request", async () => {
    useCase.error = new Error(
      "Webhook validation failed: refund amount 1000c != sale 3900c for sale s1 — full reversals only, flagged for manual review",
    );
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "Bad Request" });
  });

  it("dead-letter write failure → 500 (retryable), not 400", async () => {
    useCase.error = new Error("ledger: manual-review flag write failed: db down");
    const res = await post();
    expect(res.status).toBe(500);
  });

  it("conflict stored in the reconciliation inbox → 202 with the conflict payload, no Retry-After", async () => {
    useCase.error = null;
    useCase.outcome = { status: 202, payload: { ok: true, recorded: false, reason: "conflict_pending", conflict_id: 7, event_type: "refund", sale_id: "s1" } };
    try {
      const res = await post();
      expect(res.status).toBe(202);
      expect(res.headers.get("Retry-After")).toBeNull();
      expect(await res.json()).toEqual({ ok: true, recorded: false, reason: "conflict_pending", conflict_id: 7, event_type: "refund", sale_id: "s1" });
    } finally {
      useCase.outcome = undefined;
    }
  });

  it("success → 200", async () => {
    useCase.error = null;
    const res = await post();
    expect(res.status).toBe(200);
  });
});
