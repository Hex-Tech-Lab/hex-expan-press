import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSupabaseAdmin } from "../src/supabase_admin";
import { productionDeps } from "../src/delivery";

// Applies the production filters to an in-memory audit_log, so the provider scope is checked against real rows
// rather than against the call shape. Covers: a confirmation written by another provider with the same sale ID,
// and a legacy confirmation written before details.provider existed.

type Row = { id: number; event: string; details: Record<string, unknown> };
let rows: Row[] = [];

function fakeClient() {
  return {
    from(table: string) {
      if (table !== "audit_log") throw new Error(`unexpected table ${table}`);
      let matched = rows;
      const read = (r: Row, col: string): unknown => {
        if (col === "event") return r.event;
        const key = /^details->>(.+)$/.exec(col)?.[1];
        return key ? r.details[key] : undefined;
      };
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          matched = matched.filter((r) => read(r, col) === val);
          return chain;
        },
        is: (col: string, val: null) => {
          matched = matched.filter((r) => (read(r, col) ?? null) === val);
          return chain;
        },
        order: () => chain,
        limit: (n: number) => {
          matched = matched.slice(0, n);
          return chain;
        },
        insert: () => chain,
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null }).then(res, rej),
      };
      return chain;
    },
  };
}

vi.mock("../src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn() }));

const db = () => productionDeps().db;

beforeEach(() => {
  rows = [
    // Paddle delivered sale shared-42 with the provider recorded.
    { id: 1, event: "DELIVERY_LINK_SENT", details: { sale_id: "shared-42", provider: "paddle" } },
    // Legacy confirmation for sale legacy-7, written before details.provider existed.
    { id: 2, event: "DELIVERY_LINK_SENT", details: { sale_id: "legacy-7" } },
  ];
  vi.mocked(getSupabaseAdmin).mockResolvedValue(fakeClient() as unknown as Awaited<ReturnType<typeof getSupabaseAdmin>>);
});

describe("deliveryConfirmed against provider-scoped audit rows", () => {
  it("a paddle confirmation does not satisfy a fungies lookup for the same sale ID", async () => {
    expect(await db().deliveryConfirmed("fungies", "shared-42")).toBe(false);
  });

  it("the same provider and sale ID is confirmed", async () => {
    expect(await db().deliveryConfirmed("paddle", "shared-42")).toBe(true);
  });

  it("a legacy confirmation with no details.provider never matches, so the link is re-sent", async () => {
    expect(await db().deliveryConfirmed("paddle", "legacy-7")).toBe(false);
    expect(await db().deliveryConfirmed("fungies", "legacy-7")).toBe(false);
  });

  it("warns when a legacy confirmation is bypassed, since the buyer gets a second email", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await db().deliveryConfirmed("paddle", "legacy-7")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacy confirmation without provider for sale legacy-7"));
    warn.mockRestore();
  });

  it("does not warn when there is no confirmation at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await db().deliveryConfirmed("paddle", "never-sent")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
