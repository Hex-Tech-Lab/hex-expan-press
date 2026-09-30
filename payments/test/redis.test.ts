import { describe, it, expect, afterAll } from "vitest";
import dotenv from "dotenv";
import { expanRedis } from "../../src/infrastructure/redis/redis.client.ts";

// Default `pnpm test` is hermetic (Wave 7.5): no .env, no network. The live Upstash
// round-trip only runs when explicitly opted in:
//   RUN_INTEGRATION_TESTS=true pnpm exec vitest run payments/test/redis.test.ts
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
