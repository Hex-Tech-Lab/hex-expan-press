// Wave 7: a delivery that hits a lock held by an unpersisted in-flight delivery
// must be answered 503 + Retry-After (provider retries) — never 200, because the
// lock holder may still fail and the sale would be lost.
import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("../../../../../../src/use_cases/billing/process_billing_webhook", () => ({
  processBillingWebhookUseCase: vi.fn(async () => {
    const err = new Error("webhook in flight: lock lock:sale:polar:s1 is held by another delivery");
    err.name = "WebhookInFlightError";
    throw err;
  }),
}));

import { POST } from "../route";

describe("billing webhook — in-flight lock contention (Wave 7)", () => {
  it("answers 503 with Retry-After, not 200", async () => {
    const req = new Request("https://expanpress.com/api/billing/webhook", { method: "POST", body: "{}" });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});
