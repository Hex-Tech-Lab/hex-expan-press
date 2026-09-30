import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import dotenv from "dotenv";
import { expanRedis, ExpanRedisClient } from "../../src/infrastructure/redis/redis.client.ts";

// Default `pnpm test` is hermetic (Wave 7.5): no .env, no network. The live Upstash
// round-trip only runs when explicitly opted in:
//   RUN_INTEGRATION_TESTS=true pnpm exec vitest run payments/test/redis.test.ts
//
// Import order is safe: ES imports are hoisted above this dotenv call, but the client
// reads credentials LAZILY on every command (getUrl/getToken → redisRestEnv()), never
// at construction. The "reads env at call time" test below locks that invariant in.
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "true";
if (RUN_INTEGRATION) dotenv.config({ path: ".env", override: true });

describe.skipIf(!RUN_INTEGRATION)("payments/src/redis — live Upstash namespace isolation (integration)", () => {
  const testKey = "test:safety_check_" + Date.now();

  afterAll(async () => {
    await expanRedis.del(testKey);
  });

  it("stores and retrieves keys strictly under expan: namespace", async () => {
    await expanRedis.set(testKey, "safe_value", 60);
    const val = await expanRedis.get(testKey);
    expect(val).toBe("safe_value");
  });
});

// Offline: the FLUSH guard throws before any credential lookup or HTTP call, so this
// safety check stays in the default suite.
describe("payments/src/redis (FLUSH guard, offline)", () => {
  it("blocks dangerous FLUSH commands unconditionally", async () => {
    //  testing private safety guard against raw flush
    await expect(expanRedis["command"]("FLUSHDB")).rejects.toThrow("strictly forbidden");
    //  testing private safety guard against raw flush
    await expect(expanRedis["command"]("FLUSHALL")).rejects.toThrow("strictly forbidden");
  });
});

// Offline guard for the import-order invariant above: a client constructed BEFORE the
// env exists must pick up credentials set afterwards (as dotenv does post-import).
describe("payments/src/redis (lazy credential read, offline)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads env at call time, not at construction", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    const client = new ExpanRedisClient(); // constructed with NO credentials available
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: "v" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://late.unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "late-token");
    await client.get("k");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://late.unit.test.redis.example");
  });
});
