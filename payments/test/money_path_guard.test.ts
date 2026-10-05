// F4 money-path guard (sprint10 audit remediation): the unified isMoneyPath predicate
// (NODE_ENV=production OR any VERCEL_ENV OR AWS_LAMBDA_FUNCTION_NAME) must fail CLOSED
// on ambiguous production-shaped runtimes — the idempotency lock throws when Redis is
// unconfigured and the manual-review DLQ flag throws when Supabase is unconfigured —
// while a bare local/test runtime (no signal at all) keeps the optional-infra behavior.
// Hermetic: no .env, no network, no real Redis — every env input is stubbed explicitly.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isMoneyPath } from "../src/settings_registry.ts";
import { withIdempotencyLock } from "../src/webhook_core.ts";
import { flagRefundForManualReview } from "../src/ledger.ts";

const UNSET = undefined as unknown as string;

function stubNoRedis(): void {
  // Empty strings make isRedisRestConfigured() false (Boolean("" && …) === false) —
  // stubbing all four candidate vars keeps the test hermetic against inherited shell env.
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("KV_REST_API_URL", "");
  vi.stubEnv("KV_REST_API_TOKEN", "");
}

function stubNoSupabase(): void {
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
}

const manualReviewInput = {
  provider: "paddle",
  sale_id: "sale_money_path_guard_1",
  refund_id: null,
  reason: "amount_mismatch" as const,
  refund_cents: null,
  sale_cents: null,
  creator_id: null,
  occurred_at: "2026-10-04T00:00:00.000Z",
};

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("money-path guard: withIdempotencyLock (Redis unconfigured)", () => {
  it("throws the lock-unavailable error when NODE_ENV=production (no VERCEL_ENV needed anymore)", async () => {
    stubNoRedis();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", UNSET);
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", UNSET);
    await expect(
      withIdempotencyLock("lock:test:prod", async () => ({ status: 200, payload: { ok: true, recorded: true } })),
    ).rejects.toThrow("webhook idempotency lock unavailable");
  });

  it("runs unlocked when all three money-path signals are unset (unchanged local behavior)", async () => {
    stubNoRedis();
    vi.stubEnv("NODE_ENV", UNSET);
    vi.stubEnv("VERCEL_ENV", UNSET);
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", UNSET);
    const fn = vi.fn(async () => ({ status: 200, payload: { ok: true, recorded: true } }));
    const result = await withIdempotencyLock("lock:test:local", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 200, payload: { ok: true, recorded: true } });
  });

  it("fails closed under VERCEL_ENV=preview with NODE_ENV unset (preview is a money path)", async () => {
    stubNoRedis();
    vi.stubEnv("NODE_ENV", UNSET);
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", UNSET);
    expect(isMoneyPath()).toBe(true);
    await expect(
      withIdempotencyLock("lock:test:preview", async () => ({ status: 200, payload: { ok: true, recorded: true } })),
    ).rejects.toThrow("webhook idempotency lock unavailable");
  });
});

describe("money-path guard: flagRefundForManualReview (Supabase unconfigured)", () => {
  it("throws when NODE_ENV=production so the webhook 500s and the provider retries", async () => {
    stubNoSupabase();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", UNSET);
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", UNSET);
    await expect(flagRefundForManualReview(manualReviewInput)).rejects.toThrow(
      "manual-review flag cannot be persisted",
    );
  });

  it("logs to console.error and returns when all three money-path signals are unset (unchanged local behavior)", async () => {
    stubNoSupabase();
    vi.stubEnv("NODE_ENV", UNSET);
    vi.stubEnv("VERCEL_ENV", UNSET);
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", UNSET);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(flagRefundForManualReview(manualReviewInput)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("MANUAL_REVIEW_REQUIRED_REFUND");
  });
});

describe("money-path guard: isMoneyPath predicate", () => {
  it("is an exported function returning a boolean, false in a clean env", () => {
    expect(typeof isMoneyPath).toBe("function");
    vi.stubEnv("NODE_ENV", UNSET);
    vi.stubEnv("VERCEL_ENV", UNSET);
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", UNSET);
    expect(isMoneyPath()).toBe(false);
    expect(typeof isMoneyPath()).toBe("boolean");
  });

  it.each([
    ["NODE_ENV", "production"],
    ["VERCEL_ENV", "preview"],
    ["VERCEL_ENV", "development"],
    ["AWS_LAMBDA_FUNCTION_NAME", "payments-webhook"],
  ])("returns true when %s=%j alone is set", (envKey, value) => {
    vi.stubEnv("NODE_ENV", UNSET);
    vi.stubEnv("VERCEL_ENV", UNSET);
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", UNSET);
    vi.stubEnv(envKey, value);
    expect(isMoneyPath()).toBe(true);
  });
});
