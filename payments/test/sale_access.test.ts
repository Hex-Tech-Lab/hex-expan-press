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

  it("refuses an unknown event type rather than guessing", () => {
    expect(() => saleAccessState([{ event_type: "sale" }, { event_type: "chargeback" as never }])).toThrow(/unknown event_type/);
  });
});

type Row = { provider: string; event_type: string; occurred_at: string };

/** Minimal stand-in for the chained PostgREST builder readSaleAccessEvents uses. */
function fakeSupabase(result: { data: Row[] | null; error: { message: string } | null }) {
  const calls: unknown[][] = [];
  const builder = {
    select: (...args: unknown[]) => (calls.push(["select", ...args]), builder),
    eq: (...args: unknown[]) => (calls.push(["eq", ...args]), builder),
    order: (...args: unknown[]) => (calls.push(["order", ...args]), builder),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  return {
    client: { from: (table: string) => (calls.push(["from", table]), builder) } as never,
    calls,
  };
}

describe("readSaleAccessEvents", () => {
  it("reads the sale's rows for one provider in occurred_at order", async () => {
    const { client, calls } = fakeSupabase({
      data: [
        { provider: "paddle", event_type: "sale", occurred_at: "2026-10-01T00:00:00Z" },
        { provider: "paddle", event_type: "refund", occurred_at: "2026-10-05T00:00:00Z" },
      ],
      error: null,
    });
    const events = await readSaleAccessEvents(client, "sale-1");
    expect(events).toEqual([{ event_type: "sale" }, { event_type: "refund" }]);
    expect(calls).toContainEqual(["from", "orders"]);
    expect(calls).toContainEqual(["eq", "sale_id", "sale-1"]);
    expect(calls).toContainEqual(["order", "occurred_at", { ascending: true }]);
  });

  it("throws when the read fails (the caller then fails closed)", async () => {
    const { client } = fakeSupabase({ data: null, error: { message: "boom" } });
    await expect(readSaleAccessEvents(client, "sale-1")).rejects.toThrow(/boom/);
  });

  it("throws when one sale_id is recorded under more than one provider", async () => {
    const { client } = fakeSupabase({
      data: [
        { provider: "paddle", event_type: "sale", occurred_at: "2026-10-01T00:00:00Z" },
        { provider: "fastspring", event_type: "sale", occurred_at: "2026-10-01T00:00:00Z" },
      ],
      error: null,
    });
    await expect(readSaleAccessEvents(client, "sale-1")).rejects.toThrow(/more than one provider/);
  });
});
