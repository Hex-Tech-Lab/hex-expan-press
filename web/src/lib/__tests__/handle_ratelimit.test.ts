import { afterEach, describe, expect, it, vi } from "vitest";

import { checkHandleRateLimit, HANDLE_RATE_LIMIT } from "../handle_ratelimit";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkHandleRateLimit: policy when Redis is not configured", () => {
  it("fails closed in production (a missing secret must never disable the limit)", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(await checkHandleRateLimit("203.0.113.7")).toEqual({ kind: "unavailable" });
  });

  it("allows in test, so local and e2e runs need no Redis", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    vi.stubEnv("NODE_ENV", "test");
    expect(await checkHandleRateLimit("203.0.113.7")).toEqual({ kind: "allowed" });
  });
});

describe("policy constants", () => {
  it("documents the approved window: 30 checks per 60 seconds", () => {
    expect(HANDLE_RATE_LIMIT).toEqual({ requests: 30, windowSeconds: 60 });
  });
});
