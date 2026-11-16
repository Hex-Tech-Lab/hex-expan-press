// resolveProductByAlias: a sale resolves only to a product owned by the provider that sent it (F-18), and the
// product's checkout_mode is returned for the mode gate (F-09).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSupabaseAdmin } from "../src/supabase_admin";
import { resolveProductByAlias } from "../src/webhook_core";

vi.mock("../src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn() }));

type Row = Record<string, unknown>;

// Fake PostgREST table. `.eq` filters rows like PostgREST does. `.or` is not evaluated: every row is a
// candidate for the alias, so the provider filter is the only narrowing. `.maybeSingle` errors on more
// than one match, as PostgREST does, so an unscoped lookup over cross-provider rows fails.
const selects: string[] = [];
const eqCalls: Array<[string, unknown]> = [];
let table: Row[] = [];
function serve(row: unknown): void {
  table = Array.isArray(row) ? (row as Row[]) : [row as Row];
  const client = {
    from: () => {
      const filters: Array<[string, unknown]> = [];
      const chain = {
        select: (cols: string) => {
          selects.push(cols);
          return chain;
        },
        or: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          eqCalls.push([col, val]);
          return chain;
        },
        maybeSingle: async () => {
          const matches = table.filter((r) => filters.every(([c, v]) => r[c] === v));
          if (matches.length > 1) {
            return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
          }
          return { data: matches[0] ?? null, error: null };
        },
      };
      return chain;
    },
  };
  vi.mocked(getSupabaseAdmin).mockResolvedValue(client as unknown as Awaited<ReturnType<typeof getSupabaseAdmin>>);
}

const PADDLE_ROW = { store_product_id: "prod_1", currency: "USD", provider: "paddle", checkout_mode: "live", creators: { handle: "duane" } };

beforeEach(() => {
  selects.length = 0;
  eqCalls.length = 0;
});

describe("resolveProductByAlias: the product must belong to the sending provider (F-18)", () => {
  it("a Polar sale on a Paddle-owned product resolves to null, not a product", async () => {
    serve(PADDLE_ROW);
    expect(await resolveProductByAlias("prod_1", "polar")).toBeNull();
  });

  it("a foreign row that is also incomplete resolves to null, never a retryable 503 loop", async () => {
    serve({ ...PADDLE_ROW, store_product_id: null, creators: null });
    expect(await resolveProductByAlias("prod_1", "polar")).toBeNull();
  });

  it("a Paddle sale on its own Paddle-owned product resolves, with its checkout mode", async () => {
    serve(PADDLE_ROW);
    expect(await resolveProductByAlias("prod_1", "paddle")).toEqual({
      productId: "prod_1",
      creatorHandle: "duane",
      currency: "USD",
      checkoutMode: "live",
    });
  });

  it("the lookup is scoped to the sending provider in the query itself", async () => {
    serve(PADDLE_ROW);
    await resolveProductByAlias("prod_1", "paddle");
    expect(eqCalls).toContainEqual(["provider", "paddle"]);
  });

  it("two rows match the same alias for different providers: the lookup returns only the sender's row", async () => {
    // Before the provider filter, both rows matched the alias and maybeSingle errored, so a Paddle sale
    // could not resolve at all while a Polar product shared its alias.
    serve([
      { ...PADDLE_ROW, checkout_mode: "live" },
      { ...PADDLE_ROW, provider: "polar", checkout_mode: "sandbox" },
    ]);
    expect(await resolveProductByAlias("prod_1", "paddle")).toEqual({
      productId: "prod_1",
      creatorHandle: "duane",
      currency: "USD",
      checkoutMode: "live",
    });
  });
});

describe("resolveProductByAlias: returns checkout_mode (F-09)", () => {
  it("selects checkout_mode from products", async () => {
    serve(PADDLE_ROW);
    await resolveProductByAlias("prod_1", "paddle");
    expect(selects[0]).toContain("checkout_mode");
  });

  it.each(["live", "sandbox", "gated", "paddle", null] as const)("returns checkoutMode %s unchanged", async (mode) => {
    serve({ ...PADDLE_ROW, checkout_mode: mode });
    expect((await resolveProductByAlias("prod_1", "paddle"))?.checkoutMode).toBe(mode);
  });
});
