import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { nextRail, skipRail, resetRails } from "../src/provider_router.ts";

// Deterministic CI (Wave 7.4): the router's state store is an in-memory Map, not live
// Upstash. The suite used to dotenv-load .env and hit the real Redis over the network,
// so network latency made the ratio tests flaky and CI depended on secrets. Only the
// client is faked — the real env helpers (isRedisRestConfigured) stay, and env is
// stubbed so MatrixRouter takes its Redis code path (the path under test), never the
// file fallback. Mirrors the used ExpanRedisClient surface: get / set / del.
const store = vi.hoisted(() => new Map<string, string>());
vi.mock("../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/infrastructure/redis/redis.client.ts")>()),
  expanRedis: {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string | number) => {
      store.set(key, String(value));
      return "OK";
    },
    del: async (key: string) => (store.delete(key) ? 1 : 0),
  },
}));

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
  beforeEach(async () => {
    // Fake credentials: only switch MatrixRouter onto its Redis path; the client is mocked.
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
    store.clear();
    await resetRails();
  });

  afterEach(async () => {
    await resetRails();
    vi.unstubAllEnvs();
  });

  it("uses the (mocked) Redis store, not the file fallback", async () => {
    await nextRail("t_path", rails2);
    expect([...store.keys()].some((k) => k.includes("t_path"))).toBe(true);
  });

  it("respects weight ratios over many calls (3:1)", async () => {
    const N = 40;
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const pick = await nextRail("t_ratio_2", rails2);
      counts[pick] = (counts[pick] ?? 0) + 1;
    }
    expect(counts.polar).toBeCloseTo(N * 0.75, 1);
    expect(counts.lemonsqueezy).toBeCloseTo(N * 0.25, 1);
  });

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
  });

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
