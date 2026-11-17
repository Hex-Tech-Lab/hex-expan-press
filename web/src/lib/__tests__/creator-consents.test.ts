import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCreatorConsentRows } from "../creator-consents";
import type { PortalConsentRow } from "../consent-chain";

function makeSupabaseMock(rows: PortalConsentRow[]) {
  const inCalls: Array<[string, string[]]> = [];
  const eqCalls: Array<[string, unknown]> = [];
  const from = vi.fn(() => {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn((col: string, val: unknown) => {
        eqCalls.push([col, val]);
        return chain;
      }),
      in: vi.fn((col: string, vals: string[]) => {
        inCalls.push([col, vals]);
        return chain;
      }),
      order: vi.fn(() => chain),
      range: vi.fn(async () => ({ data: rows, error: null })),
    };
    return chain;
  });

  return {
    supabase: { from } as unknown as SupabaseClient,
    from,
    inCalls,
    eqCalls,
  };
}

describe("loadCreatorConsentRows", () => {
  it.each([null, undefined, ""])("returns missing-owner error when creatorId is %j without querying Supabase", async (creatorId) => {
    const { supabase, from } = makeSupabaseMock([]);
    const res = await loadCreatorConsentRows(supabase, creatorId);
    expect(res).toEqual({ rows: [], error: { message: "product has no owner" } });
    expect(from).not.toHaveBeenCalled();
  });

  it("applies .in('kind', ...) filter when options.kinds is provided", async () => {
    const c3Row: PortalConsentRow = {
      id: "c3_1",
      kind: "C3_revenue_split",
      decision: "given",
      product_id: "prod_1",
      supersedes: null,
      supersedes_ids: [],
      document_sha256: null,
    };
    const { supabase, from, inCalls, eqCalls } = makeSupabaseMock([c3Row]);

    const res = await loadCreatorConsentRows(supabase, "creator_1", { kinds: ["C3_revenue_split"] });

    expect(from).toHaveBeenCalledWith("consents");
    expect(eqCalls).toEqual([["creator_id", "creator_1"]]);
    expect(inCalls).toEqual([["kind", ["C3_revenue_split"]]]);
    expect(res).toEqual({ rows: [c3Row], error: null });
  });

  it("does not apply .in(...) when options.kinds is omitted", async () => {
    const c1Row: PortalConsentRow = {
      id: "c1_1",
      kind: "C1_data_accuracy",
      decision: "given",
      product_id: "prod_1",
      supersedes: null,
      supersedes_ids: [],
      document_sha256: null,
    };
    const { supabase, inCalls } = makeSupabaseMock([c1Row]);

    const res = await loadCreatorConsentRows(supabase, "creator_1");

    expect(inCalls).toEqual([]);
    expect(res).toEqual({ rows: [c1Row], error: null });
  });

  it("propagates Supabase errors that have a string message", async () => {
    const range = vi.fn(async () => ({ data: null, error: { message: "permission denied" } }));
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      in: vi.fn(() => chain),
      order: vi.fn(() => chain),
      range,
    };
    const supabase = { from: vi.fn(() => chain) } as unknown as SupabaseClient;

    const res = await loadCreatorConsentRows(supabase, "creator_1");

    expect(res).toEqual({ rows: [], error: { message: "permission denied" } });
  });

  it("stringifies non-standard error values without a string message", async () => {
    const range = vi.fn(async () => ({ data: null, error: { code: "ECONNRESET" } }));
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      in: vi.fn(() => chain),
      order: vi.fn(() => chain),
      range,
    };
    const supabase = { from: vi.fn(() => chain) } as unknown as SupabaseClient;

    const res = await loadCreatorConsentRows(supabase, "creator_1");

    expect(res).toEqual({ rows: [], error: { message: "[object Object]" } });
  });

  it("returns Missing consent data error when data is null and error is null", async () => {
    const range = vi.fn(async () => ({ data: null, error: null }));
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      in: vi.fn(() => chain),
      order: vi.fn(() => chain),
      range,
    };
    const supabase = { from: vi.fn(() => chain) } as unknown as SupabaseClient;

    const res = await loadCreatorConsentRows(supabase, "creator_1");

    expect(res).toEqual({ rows: [], error: { message: "Missing consent data" } });
  });

  it("paginates across multiple 500-row pages until a partial page ends the chain", async () => {
    const makeRow = (i: number): PortalConsentRow => ({
      id: `row_${i}`,
      kind: "C1_data_accuracy",
      decision: "given",
      product_id: "prod_1",
      supersedes: null,
      supersedes_ids: [],
      document_sha256: null,
    });
    const page1 = Array.from({ length: 500 }, (_, i) => makeRow(i));
    const page2 = [makeRow(500), makeRow(501)];
    const ranges: Array<[number, number]> = [];
    const range = vi.fn(async (from: number, to: number) => {
      ranges.push([from, to]);
      return { data: from === 0 ? page1 : page2, error: null };
    });
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      in: vi.fn(() => chain),
      order: vi.fn(() => chain),
      range,
    };
    const supabase = { from: vi.fn(() => chain) } as unknown as SupabaseClient;

    const res = await loadCreatorConsentRows(supabase, "creator_1");

    expect(ranges).toEqual([
      [0, 499],
      [500, 999],
    ]);
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(502);
  });

  it("fails closed when consent history reaches the 5000-row safety cap", async () => {
    const fullPage: PortalConsentRow[] = Array.from({ length: 500 }, (_, i) => ({
      id: `row_${i}`,
      kind: "C1_data_accuracy",
      decision: "given",
      product_id: "prod_1",
      supersedes: null,
      supersedes_ids: [],
      document_sha256: null,
    }));
    const range = vi.fn(async () => ({ data: fullPage, error: null }));
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      in: vi.fn(() => chain),
      order: vi.fn(() => chain),
      range,
    };
    const supabase = { from: vi.fn(() => chain) } as unknown as SupabaseClient;

    const res = await loadCreatorConsentRows(supabase, "creator_1");

    expect(range).toHaveBeenCalledTimes(10);
    expect(res).toEqual({ rows: [], error: { message: "consent history exceeds the safety cap" } });
  });
});
