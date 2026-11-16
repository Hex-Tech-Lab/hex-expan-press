// Idempotency-lock contract (Sprint 11): a held lock is never a success. withIdempotencyLock
// throws WebhookInFlightError (the route maps it to 503 + Retry-After); fn never runs.
// Release is owner-checked: the lock stores a random per-call token, and only that token may release it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const redis = vi.hoisted(() => ({ setnx: vi.fn(), compareAndDel: vi.fn() }));
vi.mock("../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/infrastructure/redis/redis.client.ts")>()),
  expanRedis: redis,
}));

import { withIdempotencyLock, WebhookInFlightError } from "../src/webhook_core.ts";
import { GLOBAL } from "../src/settings_registry.ts";

/** The token this call stored on acquire (the second argument of setnx). */
function acquiredToken(): string {
  const call = redis.setnx.mock.calls[0];
  if (!call) throw new Error("setnx was not called");
  return String(call[1]);
}

describe("withIdempotencyLock", () => {
  beforeEach(() => {
    redis.setnx.mockReset();
    redis.compareAndDel.mockReset().mockResolvedValue(1);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
    vi.stubEnv("VERCEL_ENV", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("held lock → throws WebhookInFlightError (never a 200-shaped result) and does not run fn", async () => {
    redis.setnx.mockResolvedValue(0);
    const fn = vi.fn(async () => ({ status: 200, payload: { ok: true, recorded: true } }));
    const err = await withIdempotencyLock("lock:sale:polar:s1", fn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookInFlightError);
    expect((err as WebhookInFlightError).lockKey).toBe("lock:sale:polar:s1");
    expect(fn).not.toHaveBeenCalled();
    expect(redis.compareAndDel).not.toHaveBeenCalled(); // the holder's lock is never released by a contender
    expect(redis.compareAndDel).not.toHaveBeenCalledWith("lock:sale:polar:s1", acquiredToken()); // the contender never releases with its own token
  });

  it("acquires with the registry TTL and a random owner token, keeps the lock after a recorded write", async () => {
    redis.setnx.mockResolvedValue(1);
    const res = await withIdempotencyLock("lock:sale:polar:s2", async () => ({ status: 200, payload: { recorded: true } }));
    expect(res.status).toBe(200);
    expect(redis.setnx).toHaveBeenCalledWith("lock:sale:polar:s2", expect.any(String), GLOBAL.payments.webhook_lock_ttl_seconds);
    expect(acquiredToken()).toMatch(/^[0-9a-f-]{36}$/); // a UUID, so two deliveries never share a token
    expect(redis.compareAndDel).not.toHaveBeenCalled();
  });

  it("each acquire gets its own token", async () => {
    redis.setnx.mockResolvedValue(1);
    await withIdempotencyLock("lock:sale:polar:t1", async () => ({ status: 200, payload: { recorded: false } }));
    const first = acquiredToken();
    redis.setnx.mockClear();
    await withIdempotencyLock("lock:sale:polar:t1", async () => ({ status: 200, payload: { recorded: false } }));
    expect(acquiredToken()).not.toBe(first);
  });

  it("releases the lock only with its own token when nothing was written, so a corrected retry is not blocked", async () => {
    redis.setnx.mockResolvedValue(1);
    await withIdempotencyLock("lock:sale:polar:s3", async () => ({ status: 200, payload: { recorded: false, reason: "duplicate" } }));
    expect(redis.compareAndDel).toHaveBeenCalledWith("lock:sale:polar:s3", acquiredToken());
    expect(redis.compareAndDel).toHaveBeenCalledTimes(1); // exactly one owner-checked release
  });

  it("releases with its own token and rethrows when fn throws", async () => {
    redis.setnx.mockResolvedValue(1);
    await expect(withIdempotencyLock("lock:sale:polar:s4", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(redis.compareAndDel).toHaveBeenCalledWith("lock:sale:polar:s4", acquiredToken());
    expect(redis.compareAndDel).toHaveBeenCalledTimes(1); // exactly one owner-checked release
  });

  it("a failed lock release does not replace the caller's error", async () => {
    redis.setnx.mockResolvedValue(1);
    redis.compareAndDel.mockRejectedValue(new Error("redis down"));
    const err = await withIdempotencyLock("lock:sale:polar:s6", async () => { throw new Error("boom"); }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("boom");
  });

  it("a failed lock release after a non-recorded result does not turn success into an error", async () => {
    redis.setnx.mockResolvedValue(1);
    redis.compareAndDel.mockRejectedValue(new Error("redis down"));
    const res = await withIdempotencyLock("lock:sale:polar:s7", async () => ({ status: 200, payload: { recorded: false, reason: "duplicate" } }));
    expect(res).toMatchObject({ status: 200 });
  });

  it("production without Redis config fails closed instead of running unlocked", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    vi.stubEnv("VERCEL_ENV", "production");
    const fn = vi.fn(async () => ({ status: 200, payload: {} }));
    await expect(withIdempotencyLock("lock:sale:polar:s5", fn)).rejects.toThrow(/Redis is not configured in a money-path runtime/);
    expect(fn).not.toHaveBeenCalled();
  });
});
