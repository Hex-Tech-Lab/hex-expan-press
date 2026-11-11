import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Upstash resolves { success: true, reason: "timeout" } when Redis stalls past its timeout (5 s default).
// That shape looks like an allowed request, so the policy must read `reason`, not only `success`.
const upstash = vi.hoisted(() => ({
  next: null as unknown,
}));

// What the production code hands to the library. Asserted below, so a wrong window, prefix,
// Redis credential, or limited key fails the suite instead of passing silently.
const seen = vi.hoisted(() => ({
  windowArgs: null as unknown[] | null,
  limiterConfig: null as Record<string, unknown> | null,
  redisConfig: null as Record<string, unknown> | null,
  limitedKeys: [] as string[],
}));

vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow(...args: unknown[]): unknown {
      seen.windowArgs = args;
      return {};
    }
    constructor(config: Record<string, unknown>) {
      seen.limiterConfig = config;
    }
    async limit(key: string): Promise<unknown> {
      seen.limitedKeys.push(key);
      if (upstash.next === "THROW") throw new Error("connect ECONNREFUSED limiter.example.test test-token");
      return upstash.next;
    }
  }
  return { Ratelimit };
});

vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor(config: Record<string, unknown>) {
      seen.redisConfig = config;
    }
  },
}));

const sentryCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => {
    sentryCalls.push(args);
  },
}));

import { checkHandleRateLimit } from "../handle_ratelimit";

beforeEach(() => {
  // Reset per test, so a presence check cannot be satisfied by a call from an earlier test.
  sentryCalls.length = 0;
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://limiter.example.test");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("checkHandleRateLimit: Upstash timeout response", () => {
  it("fails closed when the limiter reports a timeout, even though success is true", async () => {
    upstash.next = { success: true, limit: 0, remaining: 0, reset: 0, reason: "timeout" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkHandleRateLimit("203.0.113.7")).toEqual({ kind: "unavailable" });
    expect(errSpy).toHaveBeenCalled();
    expect(sentryCalls.length).toBeGreaterThan(0);
  });

  it("still allows a normal under-limit response", async () => {
    upstash.next = { success: true, limit: 30, remaining: 29, reset: Date.now() + 60_000 };
    expect(await checkHandleRateLimit("203.0.113.7")).toEqual({ kind: "allowed" });
  });

  it("reports limited with a Retry-After of at least one second when over the limit", async () => {
    upstash.next = { success: false, limit: 30, remaining: 0, reset: Date.now() + 42_000 };
    expect(await checkHandleRateLimit("203.0.113.7")).toEqual({ kind: "limited", retryAfterSeconds: 42 });
  });

  it("a reset in the past still gives Retry-After of 1, never zero or NaN", async () => {
    upstash.next = { success: false, limit: 30, remaining: 0, reset: Date.now() - 5_000 };
    expect(await checkHandleRateLimit("203.0.113.7")).toEqual({ kind: "limited", retryAfterSeconds: 1 });
  });

  it("a missing reset still gives Retry-After of 1, never NaN", async () => {
    upstash.next = { success: false, limit: 30, remaining: 0 };
    expect(await checkHandleRateLimit("203.0.113.7")).toEqual({ kind: "limited", retryAfterSeconds: 1 });
  });

  it("fails closed when the limiter throws, and the log carries no endpoint or token", async () => {
    upstash.next = "THROW";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkHandleRateLimit("203.0.113.7")).toEqual({ kind: "unavailable" });
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/failing closed/);
    expect(logged).not.toMatch(/limiter\.example|test-token/);
    // JSON.stringify(new Error(...)) is "{}", so it cannot see the message. Read the message and stack directly.
    expect(sentryCalls.length).toBeGreaterThan(0);
    const sentText = sentryCalls
      .map(([err]) => {
        const reported = err as Error;
        return `${reported?.message ?? ""}\n${reported?.stack ?? ""}`;
      })
      .join("\n");
    expect(sentText).not.toMatch(/limiter\.example|test-token/);
  });
});

describe("checkHandleRateLimit: limiter configuration", () => {
  it("uses the approved window: 30 checks per 60 seconds, sliding", async () => {
    upstash.next = { success: true, limit: 30, remaining: 29, reset: Date.now() + 60_000 };
    await checkHandleRateLimit("203.0.113.7");
    expect(seen.windowArgs).toEqual([30, "60 s"]);
  });

  it("namespaces its keys under expan: like every other Redis key (redis.client.ts), so they cannot collide", async () => {
    upstash.next = { success: true, limit: 30, remaining: 29, reset: Date.now() + 60_000 };
    await checkHandleRateLimit("203.0.113.7");
    expect(seen.limiterConfig?.prefix).toBe("expan:handle-availability");
  });

  it("passes the Redis REST URL and token from the environment to the client", async () => {
    upstash.next = { success: true, limit: 30, remaining: 29, reset: Date.now() + 60_000 };
    await checkHandleRateLimit("203.0.113.7");
    expect(seen.redisConfig).toEqual({ url: "https://limiter.example.test", token: "test-token" });
  });

  it("limits by the client IP it was given, not a shared constant key", async () => {
    upstash.next = { success: true, limit: 30, remaining: 29, reset: Date.now() + 60_000 };
    seen.limitedKeys.length = 0;
    await checkHandleRateLimit("198.51.100.23");
    expect(seen.limitedKeys).toEqual(["198.51.100.23"]);
  });
});
