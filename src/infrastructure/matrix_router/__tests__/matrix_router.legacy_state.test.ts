// PR 136: a legacy breaker value that is valid JSON but malformed must not fail open. It throws into the degraded handler,
// which answers MatrixRouterUnavailableError (503), instead of re-enabling a rail that is marked down.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixRouter } from "../matrix_router.ts";
import { MatrixRouterUnavailableError } from "../matrix_router_errors.ts";

const fake = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("../../redis/redis.client.ts", () => ({
  isRedisRestConfigured: () => true,
  expanRedis: {
    get: vi.fn(async (key: string) => fake.store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string | number) => {
      fake.store.set(key, String(value));
      return "OK";
    }),
    incr: vi.fn(async (key: string) => {
      const next = (Number(fake.store.get(key)) || 0) + 1;
      fake.store.set(key, String(next));
      return next;
    }),
  },
}));

const ROUTES = [
  { provider: "paddle", weight: 1 },
  { provider: "creem", weight: 1 },
] as never;
const LEGACY_KEY = "matrix:checkout:ctx-1";
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe("MatrixRouter legacy breaker state is validated, not trusted", () => {
  beforeEach(() => {
    fake.store.clear();
  });

  it.each([
    ["the document is null", "null"],
    ["the document is an array", "[]"],
    ["the down map is a string", JSON.stringify({ down: "paddle" })],
    ["the down map is an array", JSON.stringify({ down: [FUTURE] })],
    ["a down timestamp is not a date", JSON.stringify({ down: { paddle: "not-a-date" } })],
    ["a down timestamp is a number", JSON.stringify({ down: { paddle: 12345 } })],
    ["one entry is invalid next to a valid one", JSON.stringify({ down: { paddle: FUTURE, creem: "garbage" } })],
  ])("throws into the degraded handler when %s", async (_label, raw) => {
    fake.store.set(LEGACY_KEY, raw);
    await expect(MatrixRouter.getNextProvider("checkout", "ctx-1", ROUTES)).rejects.toBeInstanceOf(MatrixRouterUnavailableError);
  });

  it("keeps a rail marked down by a valid legacy breaker out of rotation", async () => {
    fake.store.set(LEGACY_KEY, JSON.stringify({ down: { paddle: FUTURE }, updated_at: new Date().toISOString() }));
    for (let i = 0; i < 3; i++) {
      await expect(MatrixRouter.getNextProvider("checkout", "ctx-1", ROUTES)).resolves.toBe("creem");
    }
  });

  it("ignores an expired legacy entry in a valid document", async () => {
    fake.store.set(LEGACY_KEY, JSON.stringify({ down: { paddle: PAST }, updated_at: new Date().toISOString() }));
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) seen.add(await MatrixRouter.getNextProvider("checkout", "ctx-1", ROUTES));
    expect([...seen].sort()).toEqual(["creem", "paddle"]);
  });
});
