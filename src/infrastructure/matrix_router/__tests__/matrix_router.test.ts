import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixRouter } from "../matrix_router.ts";
import { MatrixRouterUnavailableError } from "../matrix_router_errors.ts";
import type { ProviderRoute } from "../../../domain/settings/settings.port.ts";
import { expanRedis } from "../../redis/redis.client.ts";

// In-memory Redis with an atomic INCR (one synchronous step per call, like Redis). Only the client surface the router
// uses is faked; the real ExpanRedisClient is never reached.
const fake = vi.hoisted(() => ({
  configured: true,
  store: new Map<string, string>(),
  setKeys: [] as string[],
  getFail: false,
  setFail: false,
  incrFail: false,
}));

vi.mock("../../redis/redis.client.ts", () => ({
  isRedisRestConfigured: () => fake.configured,
  expanRedis: {
    get: vi.fn(async (key: string) => {
      if (fake.getFail) throw new TypeError("redis get failed with token=secret-redis-cred");
      return fake.store.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string | number) => {
      if (fake.setFail) throw new RangeError("redis set failed with token=secret-redis-cred");
      fake.setKeys.push(key);
      fake.store.set(key, String(value));
      return "OK";
    }),
    incr: vi.fn(async (key: string) => {
      if (fake.incrFail) throw new Error("upstash unreachable");
      const next = Number(fake.store.get(key) ?? "0") + 1;
      fake.store.set(key, String(next));
      return next;
    }),
  },
}));

const NS = "payments";
const CTX = "product_1";

const routes3to1: ProviderRoute[] = [
  { provider: "paddle", weight: 3 },
  { provider: "polar", weight: 1 },
];

beforeEach(() => {
  fake.configured = true;
  fake.store.clear();
  fake.setKeys.length = 0;
  fake.getFail = false;
  fake.setFail = false;
  fake.incrFail = false;
  vi.clearAllMocks();
});

describe("MatrixRouter circuit breaker, single rail (no silent bypass)", () => {
  it("returns the only rail while it is healthy", async () => {
    const provider = await MatrixRouter.getNextProvider(NS, CTX, [{ provider: "paddle", weight: 1 }]);
    expect(provider).toBe("paddle");
  });

  it("throws MatrixRouterUnavailableError when the only rail is marked down, and never returns it", async () => {
    await MatrixRouter.markProviderDown(NS, CTX, "paddle");
    const attempt = MatrixRouter.getNextProvider(NS, CTX, [{ provider: "paddle", weight: 1 }]);
    await expect(attempt).rejects.toBeInstanceOf(MatrixRouterUnavailableError);
    await expect(attempt).rejects.toMatchObject({ code: "MATRIX_ROUTER_UNAVAILABLE", namespace: NS, contextId: CTX });
  });

  it("serves the rail again once its down window has passed", async () => {
    // A negative window is already expired, so the breaker must not hold the rail out.
    await MatrixRouter.markProviderDown(NS, CTX, "paddle", -1000);
    await expect(MatrixRouter.getNextProvider(NS, CTX, [{ provider: "paddle", weight: 1 }])).resolves.toBe("paddle");
  });

  it("keeps the single rail live when Redis is not configured, since there is no breaker state to read", async () => {
    fake.configured = false;
    await expect(MatrixRouter.getNextProvider(NS, CTX, [{ provider: "paddle", weight: 1 }])).resolves.toBe("paddle");
    expect(fake.setKeys).toHaveLength(0);
  });
});

describe("MatrixRouter circuit breaker, multiple rails", () => {
  it("routes around a rail that is marked down", async () => {
    await MatrixRouter.markProviderDown(NS, CTX, "paddle");
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) picks.push(await MatrixRouter.getNextProvider(NS, CTX, routes3to1));
    expect(picks.every((p) => p === "polar")).toBe(true);
  });

  it("throws MatrixRouterUnavailableError when every rail is marked down", async () => {
    await MatrixRouter.markProviderDown(NS, CTX, "paddle");
    await MatrixRouter.markProviderDown(NS, CTX, "polar");
    await expect(MatrixRouter.getNextProvider(NS, CTX, routes3to1)).rejects.toBeInstanceOf(MatrixRouterUnavailableError);
  });

  it("rejects an empty route list with a plain error, not the unavailable error", async () => {
    await expect(MatrixRouter.getNextProvider(NS, CTX, [])).rejects.toThrow("No routes provided");
  });
});

describe("MatrixRouter round-robin counter is atomic", () => {
  it("uses INCR for the counter, never a GET-modify-SET on the counter key", async () => {
    await MatrixRouter.getNextProvider(NS, CTX, routes3to1);
    expect(vi.mocked(expanRedis.incr)).toHaveBeenCalledWith(
      `matrix:${NS}:${CTX}:counter`,
    );
    expect(fake.setKeys.some((k) => k.endsWith(":counter"))).toBe(false);
  });

  it("gives concurrent requests distinct positions, so the 3:1 split is exact under concurrency", async () => {
    // 40 concurrent picks over a 3:1 weight sum of 4: an atomic counter gives exactly 30 / 10. A lost update
    // (read-modify-write) would let two requests read the same counter and skew the split.
    const picks = await Promise.all(Array.from({ length: 40 }, () => MatrixRouter.getNextProvider(NS, CTX, routes3to1)));
    const counts = picks.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p]: (acc[p] ?? 0) + 1 }), {});
    expect(counts).toEqual({ paddle: 30, polar: 10 });
  });

  it("keeps the first pick on the highest-weight rail, as before", async () => {
    const first = await MatrixRouter.getNextProvider(NS, CTX, routes3to1);
    expect(first).toBe("paddle");
  });

  it("falls back to the default route when INCR fails, without throwing", async () => {
    fake.incrFail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(MatrixRouter.getNextProvider(NS, CTX, routes3to1)).resolves.toBe("paddle");
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0] ?? "");
      expect(logged).toContain("Error");
      expect(logged).toContain("degraded");
      expect(logged).not.toContain("upstash unreachable");
    } finally {
      warn.mockRestore();
    }
  });

  it("returns the first rail with no Redis calls when Redis is not configured", async () => {
    fake.configured = false;
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) picks.push(await MatrixRouter.getNextProvider(NS, CTX, routes3to1));
    expect(picks).toEqual(["paddle", "paddle", "paddle", "paddle"]);
    expect(vi.mocked(expanRedis.incr)).not.toHaveBeenCalled();
  });
});

describe("MatrixRouter Redis failure handling (fail closed on read, degraded on write)", () => {
  it("does not bypass an open circuit breaker when Redis read fails (rejects with MatrixRouterUnavailableError)", async () => {
    await MatrixRouter.markProviderDown(NS, CTX, "paddle");
    fake.getFail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(MatrixRouter.getNextProvider(NS, CTX, routes3to1)).rejects.toBeInstanceOf(
        MatrixRouterUnavailableError,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0] ?? "");
      expect(logged).toContain("TypeError");
      expect(logged).toContain("degraded");
      expect(logged).not.toContain("secret-redis-cred");
      expect(logged).not.toContain("redis get failed");
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects single-rail routing with MatrixRouterUnavailableError on malformed Redis breaker JSON", async () => {
    fake.store.set(`matrix:${NS}:${CTX}`, "{not-valid-json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        MatrixRouter.getNextProvider(NS, CTX, [{ provider: "paddle", weight: 1 }]),
      ).rejects.toBeInstanceOf(MatrixRouterUnavailableError);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0] ?? "");
      expect(logged).toContain("SyntaxError");
      expect(logged).toContain("degraded");
      expect(logged).not.toContain("{not-valid-json");
    } finally {
      warn.mockRestore();
    }
  });

  it("reports degraded without overwriting breaker state when markProviderDown hits a Redis read failure", async () => {
    fake.getFail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await MatrixRouter.markProviderDown(NS, CTX, "paddle");
      expect(res).toEqual({ degraded: true });
      expect(vi.mocked(expanRedis.set)).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("TypeError");
    } finally {
      warn.mockRestore();
    }
  });

  it("logs error name only and returns degraded when markProviderDown hits a Redis save failure", async () => {
    fake.setFail = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await MatrixRouter.markProviderDown(NS, CTX, "paddle");
      expect(res).toEqual({ degraded: true });
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]?.[0] ?? "");
      expect(logged).toContain("RangeError");
      expect(logged).toContain("degraded");
      expect(logged).not.toContain("secret-redis-cred");
    } finally {
      warn.mockRestore();
    }
  });
});
