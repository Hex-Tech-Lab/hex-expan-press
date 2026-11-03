import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSupabaseAdmin } from "../src/supabase_admin";
import { resolveProductByAlias } from "../src/webhook_core";

// Records the OR filter the product lookup sends. A Paddle ID must only be matchable by a Paddle sale.
const seen: string[] = [];
const row = { store_product_id: "duane_retirement_playbook_v1", currency: "USD", provider: "paddle", creators: { handle: "duane" } };

function fakeClient() {
  return {
    from(table: string) {
      if (table !== "products") throw new Error(`unexpected table ${table}`);
      const chain = {
        select: () => chain,
        or: (filter: string) => {
          seen.push(filter);
          return chain;
        },
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return chain;
    },
  };
}

vi.mock("../src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn() }));

const ALIAS = "shared-paddle-id-123";

beforeEach(() => {
  seen.length = 0;
  vi.mocked(getSupabaseAdmin).mockResolvedValue(fakeClient() as unknown as Awaited<ReturnType<typeof getSupabaseAdmin>>);
});

describe("resolveProductByAlias: paddle_product_id is matched only for Paddle sales", () => {
  it("a Paddle sale can match paddle_product_id", async () => {
    await resolveProductByAlias(ALIAS, "paddle");
    expect(seen[0]).toContain(`paddle_product_id.eq.${ALIAS}`);
  });

  it("a Polar sale cannot match paddle_product_id", async () => {
    await resolveProductByAlias(ALIAS, "polar");
    expect(seen[0]).not.toContain("paddle_product_id");
    expect(seen[0]).toContain(`store_product_id.eq.${ALIAS}`);
  });

  it("a Polar sale with a Paddle-only alias resolves to nothing", async () => {
    // The row the fake returns is found only through the paddle_product_id filter, which a Polar sale never sends.
    // Simulate the database: the store_product_id clause misses, so the lookup must not match the row.
    let lastFilter = "";
    const db = {
      from: () => {
        const chain = {
          select: () => chain,
          or: (filter: string) => {
            lastFilter = filter;
            seen.push(filter);
            return chain;
          },
          maybeSingle: async () => ({ data: lastFilter.includes("paddle_product_id") ? row : null, error: null }),
        };
        return chain;
      },
    };
    vi.mocked(getSupabaseAdmin).mockResolvedValue(db as unknown as Awaited<ReturnType<typeof getSupabaseAdmin>>);
    expect(await resolveProductByAlias(ALIAS, "polar")).toBeNull();
  });
});
