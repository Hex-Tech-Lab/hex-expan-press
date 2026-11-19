import { describe, it, expect, vi, beforeEach } from "vitest";

const redis = vi.hoisted(() => ({ locks: new Map<string, string>(), deleted: [] as string[] }));

vi.mock("../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/infrastructure/redis/redis.client.ts")>()),
  isRedisRestConfigured: () => true,
  expanRedis: {
    get: async (key: string) => redis.locks.get(key) ?? null,
    setnx: async (key: string, value: string) => {
      if (redis.locks.has(key)) return 0;
      redis.locks.set(key, value);
      return 1;
    },
    incr: async () => 1,
    compareAndDel: async (key: string, expected: string) => {
      if (redis.locks.get(key) !== expected) return 0;
      redis.locks.delete(key);
      redis.deleted.push(key);
      return 1;
    },
  },
}));
vi.mock("../src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { withIdempotencyLock, resolveProductByAlias } from "../src/webhook_core";
import { getSupabaseAdmin } from "../src/supabase_admin";
import { DeliveryPendingError } from "../src/delivery_errors";

beforeEach(() => {
  redis.locks.clear();
  redis.deleted.length = 0;
});

describe("withIdempotencyLock: a send cut at the request deadline keeps the sale lock (F-01a)", () => {
  it("releases the lock only after the unawaited send settles", async () => {
    let settle!: () => void;
    const background = new Promise<void>((resolve) => (settle = resolve));
    await expect(
      withIdempotencyLock("lock:sale:paddle:s1", async () => {
        throw new DeliveryPendingError("s1", new Error("budget"), background);
      }),
    ).rejects.toBeInstanceOf(DeliveryPendingError);
    expect(redis.locks.has("lock:sale:paddle:s1")).toBe(true);
    // A retry arriving now is refused while the first send is still in flight.
    await expect(withIdempotencyLock("lock:sale:paddle:s1", async () => ({ status: 200, payload: {} }))).rejects.toThrow(/in flight/);
    settle();
    await background;
    await Promise.resolve();
    expect(redis.locks.has("lock:sale:paddle:s1")).toBe(false);
  });

  it("releases the lock at once for a pending error with no background send", async () => {
    await expect(
      withIdempotencyLock("lock:sale:paddle:s2", async () => {
        throw new DeliveryPendingError("s2", new Error("ambiguous"));
      }),
    ).rejects.toBeInstanceOf(DeliveryPendingError);
    expect(redis.locks.has("lock:sale:paddle:s2")).toBe(false);
  });
});

describe("resolveProductByAlias: secondary rails (F-02b)", () => {
  const railRow = { store_product_id: "book_1", currency: "USD", provider: "polar", checkout_mode: "live", creators: { handle: "duane" } };

  function client(primary: unknown, viaRail: unknown) {
    const calls: string[] = [];
    return {
      calls,
      from() {
        const state = { rail: false };
        const chain = {
          select: (cols: string) => {
            state.rail = cols.includes("product_rails");
            return chain;
          },
          or: () => chain,
          eq: (col: string) => {
            if (col.startsWith("product_rails.")) calls.push(col);
            return chain;
          },
          maybeSingle: async () => ({ data: state.rail ? viaRail : primary, error: null }),
        };
        return chain;
      },
    };
  }

  it("resolves a Paddle sale through an active paddle row in product_rails on a polar-scalar product", async () => {
    const c = client(null, railRow);
    vi.mocked(getSupabaseAdmin).mockResolvedValue(c as never);
    await expect(resolveProductByAlias("book_1", "paddle")).resolves.toMatchObject({ productId: "book_1", creatorHandle: "duane" });
    expect(c.calls).toEqual(["product_rails.provider", "product_rails.active"]);
  });

  it("is still null when neither the scalar provider nor an active rail matches", async () => {
    vi.mocked(getSupabaseAdmin).mockResolvedValue(client(null, null) as never);
    await expect(resolveProductByAlias("book_1", "paddle")).resolves.toBeNull();
  });
});
