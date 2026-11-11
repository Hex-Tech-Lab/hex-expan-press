// Rate limit for the public handle-availability check: 30 checks per 60 seconds per client IP.
// Built on @upstash/ratelimit (sliding window). Redis credentials come from the same env contract as
// the rest of the app (redisRestEnv in src/infrastructure/redis/redis.client.ts), so there is one source.
//
// Fail-closed policy:
//   - Redis not configured: allowed only when NODE_ENV is development or test (local and e2e runs).
//     Anywhere else it reports "unavailable", so a missing secret can never silently disable the limit.
//   - Limiter error (Redis down, timeout): "unavailable". The route answers 503, never "available".

import * as Sentry from "@sentry/nextjs";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { redisRestEnv } from "../../../src/infrastructure/redis/redis.client";

export const HANDLE_RATE_LIMIT = { requests: 30, windowSeconds: 60 } as const;

export type HandleRateDecision =
  | { kind: "allowed" }
  | { kind: "limited"; retryAfterSeconds: number }
  | { kind: "unavailable" };

let limiter: Ratelimit | null = null;

function getLimiter(): Ratelimit | null {
  if (limiter) return limiter;
  const { url, token } = redisRestEnv();
  if (!url || !token) return null;
  limiter = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(HANDLE_RATE_LIMIT.requests, `${HANDLE_RATE_LIMIT.windowSeconds} s`),
    // expan: matches the shared Redis client's namespace (src/infrastructure/redis/redis.client.ts). This
    // limiter builds its own client, so the prefix has to be applied here.
    prefix: "expan:handle-availability",
  });
  return limiter;
}

function localRunAllowed(): boolean {
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

function reportUnavailable(kind: string, err?: unknown): void {
  // Log and report the failure class only. The raw error can carry the Redis endpoint or a token,
  // so neither the console line nor Sentry receives it.
  const name = err instanceof Error ? err.name : "none";
  console.error(`[handle-ratelimit] failing closed: ${kind} (${name})`);
  Sentry.captureException(new Error(`handle-ratelimit unavailable: ${kind} (${name})`), {
    tags: { surface: "handle-availability", ratelimit: kind },
  });
}

export async function checkHandleRateLimit(ip: string): Promise<HandleRateDecision> {
  try {
    const rl = getLimiter();
    if (!rl) {
      if (localRunAllowed()) return { kind: "allowed" };
      reportUnavailable("not-configured");
      return { kind: "unavailable" };
    }
    const result = await rl.limit(ip);
    // Upstash returns success: true with reason "timeout" when Redis stalls. That is not an allow.
    if (result.reason === "timeout") {
      reportUnavailable("timeout");
      return { kind: "unavailable" };
    }
    if (result.success) return { kind: "allowed" };
    const secondsLeft = Math.ceil((result.reset - Date.now()) / 1000);
    // A missing or past reset still gives a usable Retry-After: at least one second, never NaN.
    const retryAfterSeconds = Number.isFinite(secondsLeft) ? Math.max(1, secondsLeft) : 1;
    return { kind: "limited", retryAfterSeconds };
  } catch (err) {
    // Class only, never the message: the message can carry the Redis endpoint or token.
    console.error(`[handle-ratelimit] limiter threw (${err instanceof Error ? err.name : "none"})`);
    reportUnavailable("error", err);
    return { kind: "unavailable" };
  }
}
