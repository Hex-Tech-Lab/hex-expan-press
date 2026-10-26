import { expanRedis } from "../../../src/infrastructure/redis/redis.client";
import { QA_INTEL_CONFIG } from "../config";
import type { RedisPort } from "./cache";

/** The subset of the shared Redis client that the rule cache uses. */
export type RedisClientLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, exSeconds?: number): Promise<string>;
  del(key: string): Promise<number>;
};

/** Adapts the shared client to the cache's port, adding the QA-Intel key prefix to every key. */
export function createExpanRedisPort(client: RedisClientLike = expanRedis): RedisPort {
  const k = (key: string) => `${QA_INTEL_CONFIG.redisKeyPrefix}${key}`;
  return {
    getRedisValue: (key) => client.get(k(key)),
    setRedisValue: (key, raw, ttlSeconds) => client.set(k(key), raw, ttlSeconds),
    deleteRedisKey: (key) => client.del(k(key)),
  };
}
