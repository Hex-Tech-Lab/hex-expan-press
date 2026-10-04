// A thrown httpStatus-503 error from the use case (e.g. an adjustment-id
// collision that is NOT a confirmed replay) must surface as a 503 WITH a
// Retry-After header so the provider backs off before retrying — same
// contract as the in-flight branch.
import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

const useCase = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../../../../../../src/use_cases/billing/process_billing_webhook", () => ({
  processBillingWebhookUseCase: vi.fn(async () => {
    if (useCase.error) throw useCase.error;
  }),
}));

import { POST } from "../route";
import { GLOBAL } from "../../../../../../payments/src/settings_registry";

const post = () =>
  POST(new Request("https://expanpress.com/api/billing/webhook", { method: "POST", body: "{}" }) as unknown as NextRequest);

describe("billing webhook — 503 Retry-After contract", () => {
  it("a thrown httpStatus-503 error → 503 with Retry-After", async () => {
    useCase.error = Object.assign(new Error("Webhook retryable: adjustment-id collision"), { httpStatus: 503 });
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("a thrown 503 without httpStatus context still carries Retry-After via the status branch", async () => {
    useCase.error = new Error("Webhook retryable: email lookup failed");
    (useCase.error as Error & { httpStatus?: number }).httpStatus = 503;
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("Retry-After is the registry value, not a literal", async () => {
    const original = GLOBAL.payments.retry_after_seconds;
    GLOBAL.payments.retry_after_seconds = 45;
    try {
      useCase.error = Object.assign(new Error("Webhook retryable: x"), { httpStatus: 503 });
      const res = await post();
      expect(res.headers.get("Retry-After")).toBe("45");
    } finally {
      GLOBAL.payments.retry_after_seconds = original;
    }
  });
});
