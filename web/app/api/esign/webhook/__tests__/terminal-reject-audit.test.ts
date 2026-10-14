// E-sign audit boundary (ARTAS fail-closed): e-sign trails never fail open.
//  - a post-authentication terminal reject with the Supabase config missing → the request fails;
//  - a stalled quarantine insert → aborted after the registry timeout, logged, 400 still returned;
//  - an unverified sender (401) never reaches the audit path, even with the config missing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { WebhookValidationError } from "../../../../../../src/domain/webhook/webhook_errors";

const audit = vi.hoisted(() => ({
  abortSignal: null as null | ((signal: AbortSignal) => Promise<unknown>),
  inserts: 0,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: () => {
        audit.inserts += 1;
        return {
          abortSignal: (signal: AbortSignal) =>
            audit.abortSignal ? audit.abortSignal(signal) : Promise.resolve({ error: null }),
        };
      },
    }),
  }),
}));

const useCase = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../../../../../../src/use_cases/process_esign_webhook", () => ({
  processEsignWebhookUseCase: vi.fn(async () => {
    if (useCase.error) throw useCase.error;
  }),
}));
vi.mock("../../../../../../src/adapters/settings/env_settings.adapter", () => ({
  EnvSettingsAdapter: class {},
}));
vi.mock("../../../../../../src/adapters/database/supabase.adapter", () => ({
  SupabaseAdapter: class {},
}));

import { POST } from "../route";

const post = () =>
  POST(new Request("https://expanpress.com/api/esign/webhook", { method: "POST", body: "{}" }) as unknown as NextRequest);

beforeEach(() => {
  useCase.error = null;
  audit.abortSignal = null;
  audit.inserts = 0;
  vi.stubEnv("SUPABASE_URL", "https://audit.test.invalid");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test-placeholder-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("e-sign webhook — audit fail-closed", () => {
  it("post-authentication terminal reject with Supabase unset → the request fails, not a silent 400", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    useCase.error = new WebhookValidationError("payload missing productId", 400);
    await expect(post()).rejects.toThrow(/audit trail unavailable: SUPABASE_URL not set/);
    expect(audit.inserts).toBe(0);
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
    useCase.error = new WebhookValidationError("payload missing productId", 400);
    const pending = post();
    await vi.advanceTimersByTimeAsync(120_000);
    const res = await pending;
    expect(res.status).toBe(400);
    expect(aborted).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith("[esign-webhook] audit insert aborted after http_timeout_ms");
  });

  it("unverified sender (401) never reaches the audit path, even with Supabase unset", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    useCase.error = new WebhookValidationError("bad signature", 401);
    const res = await post();
    expect(res.status).toBe(401);
    expect(audit.inserts).toBe(0);
  });
});
