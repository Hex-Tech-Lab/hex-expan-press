/**
 * Single source for QA-Intel constants. Nothing outside this file repeats these values.
 * Redis keys are namespaced twice: the shared client already prefixes `expan:` (see
 * src/infrastructure/redis/redis.client.ts), and `redisKeyPrefix` isolates QA-Intel keys
 * inside that namespace. Replace with an independent Redis instance when one is provisioned.
 */
export const QA_INTEL_CONFIG = {
  baselineFile: ".qa-intel/baseline.json",
  baseRefCandidates: ["origin/master", "origin/main"],
  redisKeyPrefix: "qa-intel:",
  redisEnvVars: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
} as const;
