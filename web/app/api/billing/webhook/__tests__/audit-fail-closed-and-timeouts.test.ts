// Audit boundary of the billing webhook (ARTAS fail-closed):
//  - a missing Supabase config must surface as an error, never as a silently skipped audit;
//  - a stalled quarantine insert is aborted after the registry timeout, the log names the abort,
//    and the terminal 400 still goes out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const audit = vi.hoisted(() => ({
  // null → resolve immediately; otherwise the stub's abortSignal handler (used to stall the insert).
  abortSignal: null as null | ((signal: AbortSignal) => Promise<unknown>),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: () => ({
        abortSignal: (signal: AbortSignal) =>
          audit.abortSignal ? audit.abortSignal(signal) : Promise.resolve({ error: null }),
      }),
    }),
  }),
}));

const useCase = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../../../../../../src/use_cases/billing/process_billing_webhook", () => ({
  processBillingWebhookUseCase: vi.fn(async () => {
    if (useCase.error) throw useCase.error;
    return undefined;
  }),
}));

import { POST } from "../route";

const post = () =>
  POST(new Request("https://expanpress.com/api/billing/webhook", { method: "POST", body: "{}" }) as unknown as NextRequest);

const VALIDATION = () =>
  new Error("Webhook validation failed: amount mismatch for sale s1 — flagged for manual review");

beforeEach(() => {
  useCase.error = null;
  audit.abortSignal = null;
  vi.stubEnv("SUPABASE_URL", "https://audit.test.invalid");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test-placeholder-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("billing webhook — audit fail-closed", () => {
  it("terminal reject with Supabase unset → the request fails (no silent 400 without a quarantine record)", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    useCase.error = VALIDATION();
    await expect(post()).rejects.toThrow(/audit trail unavailable: SUPABASE_URL not set/);
  });

  it("names the missing variables only, never a value", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    useCase.error = VALIDATION();
    const err = (await post().catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("audit trail unavailable: SUPABASE_SECRET_KEY not set");
    expect(err.message).not.toContain("test-placeholder-key");
  });

  it("503 path with Supabase unset → the request fails instead of dropping the 503 audit", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("webhook in flight");
    err.name = "WebhookInFlightError";
    useCase.error = err;
    await expect(post()).rejects.toThrow(/audit trail unavailable/);
  });

  it("stalled quarantine insert → aborted after the registry timeout, logged, and 400 still returned", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let aborted = false;
    audit.abortSignal = (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    useCase.error = VALIDATION();
    const pending = post();
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await pending;
    expect(res.status).toBe(400);
    expect(aborted).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith("[billing-webhook] quarantine insert aborted after http_timeout_ms");
  });
});
