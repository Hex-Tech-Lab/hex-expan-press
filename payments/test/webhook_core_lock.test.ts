// Idempotency-lock contract (Sprint 11): a held lock is never a success. withIdempotencyLock
// throws WebhookInFlightError (the route maps it to 503 + Retry-After); fn never runs.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const redis = vi.hoisted(() => ({ setnx: vi.fn(), del: vi.fn() }));
vi.mock("../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/infrastructure/redis/redis.client.ts")>()),
  expanRedis: redis,
}));

import { withIdempotencyLock, WebhookInFlightError } from "../src/webhook_core.ts";
import { GLOBAL } from "../src/settings_registry.ts";

describe("withIdempotencyLock", () => {
  beforeEach(() => {
    redis.setnx.mockReset();
    redis.del.mockReset().mockResolvedValue(1);
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
    expect(redis.del).not.toHaveBeenCalled(); // the holder's lock is never released by a contender
  });

  it("acquires with the registry TTL, keeps the lock after a recorded write", async () => {
    redis.setnx.mockResolvedValue(1);
    const res = await withIdempotencyLock("lock:sale:polar:s2", async () => ({ status: 200, payload: { recorded: true } }));
    expect(res.status).toBe(200);
    expect(redis.setnx).toHaveBeenCalledWith("lock:sale:polar:s2", "1", GLOBAL.payments.webhook_lock_ttl_seconds);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("releases the lock when nothing was written, so a corrected retry is not blocked", async () => {
    redis.setnx.mockResolvedValue(1);
    await withIdempotencyLock("lock:sale:polar:s3", async () => ({ status: 200, payload: { recorded: false, reason: "duplicate" } }));
    expect(redis.del).toHaveBeenCalledWith("lock:sale:polar:s3");
  });

  it("releases the lock and rethrows when fn throws", async () => {
    redis.setnx.mockResolvedValue(1);
    await expect(withIdempotencyLock("lock:sale:polar:s4", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(redis.del).toHaveBeenCalledWith("lock:sale:polar:s4");
  });

  it("production without Redis config fails closed instead of running unlocked", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    vi.stubEnv("VERCEL_ENV", "production");
    const fn = vi.fn(async () => ({ status: 200, payload: {} }));
    await expect(withIdempotencyLock("lock:sale:polar:s5", fn)).rejects.toThrow(/Redis is not configured in production/);
    expect(fn).not.toHaveBeenCalled();
  });
});
