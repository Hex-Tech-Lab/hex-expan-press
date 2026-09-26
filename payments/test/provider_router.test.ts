import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import dotenv from "dotenv";
import { nextRail, skipRail, resetRails } from "../src/provider_router.ts";

dotenv.config({ path: ".env", override: true });

const rails2 = [
  { provider: "polar", weight: 3 },
  { provider: "lemonsqueezy", weight: 1 },
];

const rails3 = [
  { provider: "polar", weight: 2 },
  { provider: "lemonsqueezy", weight: 1 },
  { provider: "payhip", weight: 1 },
];

describe("payments/src/provider_router (nextRail/skipRail)", () => {
  beforeAll(() => {
    // Fail loud if Redis env is missing — silently exercising the file fallback
    // would test the wrong code path.
    if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error("provider_router tests require UPSTASH_REDIS_REST_URL/TOKEN (must hit live Upstash, not the file fallback)");
    }
  });

  beforeEach(async () => {
    await resetRails();
  }, 30_000);

  afterEach(async () => {
    await resetRails();
  }, 30_000);

  it("respects weight ratios over many calls (3:1)", async () => {
    const N = 40;
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const pick = await nextRail("t_ratio_2", rails2);
      counts[pick] = (counts[pick] ?? 0) + 1;
    }
    expect(counts.polar).toBeCloseTo(N * 0.75, 1);
    expect(counts.lemonsqueezy).toBeCloseTo(N * 0.25, 1);
  }, 60_000);

  it("respects weight ratios with three providers (2:1:1)", async () => {
    const N = 40;
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const pick = await nextRail("t_ratio_3", rails3);
      counts[pick] = (counts[pick] ?? 0) + 1;
    }
    expect(counts.polar).toBeCloseTo(N * 0.5, 1);
    expect(counts.lemonsqueezy).toBeCloseTo(N * 0.25, 1);
    expect(counts.payhip).toBeCloseTo(N * 0.25, 1);
  }, 60_000);

  it("skipRail removes a provider from rotation until its down-window expires", async () => {
    for (let i = 0; i < 8; i++) await nextRail("t_skip", rails2);
    await skipRail("t_skip", "polar", rails2, 60_000);
    for (let i = 0; i < 20; i++) {
      expect(await nextRail("t_skip", rails2)).toBe("lemonsqueezy");
    }
  });

  it("throws a clean error when every rail is down", async () => {
    await skipRail("t_all_down", "polar", rails2, 60_000);
    await skipRail("t_all_down", "lemonsqueezy", rails2, 60_000);
    await expect(nextRail("t_all_down", rails2)).rejects.toThrow(/every rail is marked down/);
  });
});
