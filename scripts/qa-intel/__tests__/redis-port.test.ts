import { describe, expect, test } from "vitest";
import { createExpanRedisPort, type RedisClientLike } from "../engine/redis-port";
import { QA_INTEL_CONFIG } from "../config";

function recordingClient() {
  const calls: { op: string; args: unknown[] }[] = [];
  const client: RedisClientLike = {
    get: async (key) => {
      calls.push({ op: "get", args: [key] });
      return key.endsWith("missing") ? null : "stored";
    },
    set: async (key, value, ttl) => {
      calls.push({ op: "set", args: [key, value, ttl] });
      return "OK";
    },
    del: async (key) => {
      calls.push({ op: "del", args: [key] });
      return 1;
    },
  };
  return { client, calls };
}

describe("createExpanRedisPort", () => {
  test("prefixes every key with the QA-Intel namespace", async () => {
    const { client, calls } = recordingClient();
    const port = createExpanRedisPort(client);
    await port.getRedisValue("rule:a");
    await port.setRedisValue("rule:a", "{}", 60);
    await port.deleteRedisKey("rule:a");
    const prefix = QA_INTEL_CONFIG.redisKeyPrefix;
    expect(calls).toEqual([
      { op: "get", args: [`${prefix}rule:a`] },
      { op: "set", args: [`${prefix}rule:a`, "{}", 60] },
      { op: "del", args: [`${prefix}rule:a`] },
    ]);
  });

  test("returns the client's value unchanged, including a miss", async () => {
    const { client } = recordingClient();
    const port = createExpanRedisPort(client);
    expect(await port.getRedisValue("hit")).toBe("stored");
    expect(await port.getRedisValue("missing")).toBeNull();
  });

  test("defaults to the shared expanRedis client when none is passed", () => {
    const port = createExpanRedisPort();
    expect(typeof port.getRedisValue).toBe("function");
    expect(typeof port.setRedisValue).toBe("function");
    expect(typeof port.deleteRedisKey).toBe("function");
  });
});
