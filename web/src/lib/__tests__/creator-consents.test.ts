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
});
