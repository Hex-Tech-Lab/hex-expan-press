import { QA_INTEL_CONFIG } from "./config";

export type CacheMode =
  | { kind: "redis" }
  | { kind: "memory"; reason: "not-requested" | "ci" };

/**
 * Decides the rule-cache backend. Asking for Redis without its credentials is an error, never
 * a silent fallback to memory. Under CI the request is honoured as an explicit in-memory run,
 * and the caller prints the reason.
 */
export function resolveCacheMode(opts: { requested: boolean; ci: boolean; redisConfigured: boolean }): CacheMode {
  if (!opts.requested) return { kind: "memory", reason: "not-requested" };
  if (opts.ci) return { kind: "memory", reason: "ci" };
  if (!opts.redisConfigured) {
    throw new Error(
      `qa-intel: --use-redis-cache needs ${QA_INTEL_CONFIG.redisEnvVars.join(" and ")} set. ` +
        "Refusing to fall back to the in-memory cache silently.",
    );
  }
  return { kind: "redis" };
}
