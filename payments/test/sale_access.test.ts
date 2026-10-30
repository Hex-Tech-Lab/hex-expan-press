import { describe, expect, it } from "vitest";
import { readSaleAccessEvents, saleAccessState } from "../src/sale_access.ts";

describe("saleAccessState", () => {
  it("a sale with no refund is active", () => {
    expect(saleAccessState([{ event_type: "sale" }])).toBe("active");
  });

  it("a legacy sale row with no event_type is a sale, so active", () => {
    expect(saleAccessState([{}])).toBe("active");
  });

  it("a refund with no later reversal revokes access", () => {
    expect(saleAccessState([{ event_type: "sale" }, { event_type: "refund" }])).toBe("revoked");
  });

  it("a refund that the provider reverses (won dispute) restores access", () => {
    expect(
      saleAccessState([{ event_type: "sale" }, { event_type: "refund" }, { event_type: "refund_reversal" }]),
    ).toBe("active");
  });

  it("a second refund after a reversal revokes access again", () => {
    expect(
      saleAccessState([
        { event_type: "sale" },
        { event_type: "refund" },
        { event_type: "refund_reversal" },
        { event_type: "refund" },
      ]),
    ).toBe("revoked");
  });

  it("a reversal with no preceding refund leaves the sale active", () => {
    expect(saleAccessState([{ event_type: "sale" }, { event_type: "refund_reversal" }])).toBe("active");
  });

  it("refuses to decide without a sale row (unknown state, fail closed by the caller)", () => {
    expect(() => saleAccessState([])).toThrow(/no sale/);
    expect(() => saleAccessState([{ event_type: "refund" }])).toThrow(/no sale/);
  });

  // Red before the fix: the option did not exist, so the ledger's active state was returned.
  it("an open manual-review flag revokes a sale the ledger shows active", () => {
    const reversed = [{ event_type: "sale" }, { event_type: "refund" }, { event_type: "refund_reversal" }];
    expect(saleAccessState(reversed)).toBe("active");
    expect(saleAccessState(reversed, { reviewOpen: true })).toBe("revoked");
  });

  it("an open review flag still refuses a sale with no sale row (unknown state)", () => {
    expect(() => saleAccessState([], { reviewOpen: true })).toThrow(/no sale/);
  });

  it("refuses an unknown event type rather than guessing", () => {
    expect(() => saleAccessState([{ event_type: "sale" }, { event_type: "chargeback" as never }])).toThrow(/unknown event_type/);
  });
});

type Row = Record<string, string>;

/**
 * Stand-in for the chained PostgREST builder readSaleAccessEvents uses. It applies eq filters and one order
 * to its rows, as PostgREST does, so a query that drops a filter or sorts by the wrong column changes the result.
 */
function fakeSupabase(rows: Row[], error: { message: string } | null = null) {
  const calls: unknown[][] = [];
  const filters: Array<[string, unknown]> = [];
  let sort: { column: string; ascending: boolean } | null = null;
  const builder = {
    select: (...args: unknown[]) => (calls.push(["select", ...args]), builder),
    eq: (column: string, value: unknown) => (calls.push(["eq", column, value]), filters.push([column, value]), builder),
    order: (column: string, opts?: { ascending?: boolean }) => {
      calls.push(["order", column, opts]);
      sort = { column, ascending: opts?.ascending !== false };
      return builder;
    },
    then: (resolve: (v: unknown) => unknown) => {
      if (error) return Promise.resolve({ data: null, error }).then(resolve);
      let data = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
      if (sort) {
        const { column, ascending } = sort;
        data = [...data].sort((a, b) => {
          const x = String(a[column]);
          const y = String(b[column]);
          return x === y ? 0 : (x < y ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return {
    client: { from: (table: string) => (calls.push(["from", table]), builder) } as never,
    calls,
  };
}

const ledgerRow = (event_type: string, created_at: string, occurred_at: string, provider = "paddle") => ({
  sale_id: "sale-1",
  provider,
  event_type,
  created_at,
  occurred_at,
});

describe("readSaleAccessEvents", () => {
  it("reads the sale's rows for one provider in insertion (created_at) order", async () => {
    const { client, calls } = fakeSupabase([
      ledgerRow("refund", "2026-10-05T00:00:00Z", "2026-10-05T00:00:00Z"),
      ledgerRow("sale", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"),
    ]);
    const events = await readSaleAccessEvents(client, "sale-1");
    expect(events).toEqual([{ event_type: "sale" }, { event_type: "refund" }]);
    expect(calls).toContainEqual(["from", "orders"]);
    expect(calls).toContainEqual(["eq", "sale_id", "sale-1"]);
    expect(calls).toContainEqual(["order", "created_at", { ascending: true }]);
  });

  // Red before the fix: ordering by the provider's occurred_at put this reversal (stamped before its refund)
  // first, so the sale read as revoked. The ledger refuses a reversal without a prior refund at write time, so
  // insertion order is the causal order.
  it("a reversal stamped before its refund still resolves active (insertion order, not provider time)", async () => {
    const { client } = fakeSupabase([
      ledgerRow("sale", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"),
      ledgerRow("refund", "2026-10-05T00:00:00Z", "2026-10-05T00:00:00Z"),
      ledgerRow("refund_reversal", "2026-10-06T00:00:00Z", "2026-10-02T00:00:00Z"),
    ]);
    const events = await readSaleAccessEvents(client, "sale-1");
    expect(saleAccessState(events)).toBe("active");
  });

  it("throws when the read fails (the caller then fails closed)", async () => {
    const { client } = fakeSupabase([], { message: "boom" });
    await expect(readSaleAccessEvents(client, "sale-1")).rejects.toThrow(/boom/);
  });

  it("throws when one sale_id is recorded under more than one provider", async () => {
    const { client } = fakeSupabase([
      ledgerRow("sale", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", "paddle"),
      ledgerRow("sale", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", "fastspring"),
    ]);
    await expect(readSaleAccessEvents(client, "sale-1")).rejects.toThrow(/more than one provider/);
  });
});
