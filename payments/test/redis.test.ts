import { describe, it, expect, afterAll } from "vitest";
import dotenv from "dotenv";
dotenv.config({ path: ".env", override: true });
import { expanRedis } from "../src/redis.ts";

describe("payments/src/redis (Namespace Isolation Safety)", () => {
  const testKey = "test:safety_check_" + Date.now();

  afterAll(async () => {
    await expanRedis.del(testKey);
  });

  it("stores and retrieves keys strictly under expan: namespace", async () => {
    await expanRedis.set(testKey, "safe_value", 60);
    const val = await expanRedis.get(testKey);
    expect(val).toBe("safe_value");
  });

  it("blocks dangerous FLUSH commands unconditionally", async () => {
    //  testing private safety guard against raw flush
    await expect(expanRedis["command"]("FLUSHDB")).rejects.toThrow("strictly forbidden");
    //  testing private safety guard against raw flush
    await expect(expanRedis["command"]("FLUSHALL")).rejects.toThrow("strictly forbidden");
  });
});
