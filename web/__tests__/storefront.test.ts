import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../src/components/storefront/storefront.css", () => ({}));
vi.mock("../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => null) }));

const { NOINDEX, insideItems, storefrontRobots } = await import("../src/components/storefront/storefront");

describe("storefrontRobots (Sprint 17 P3)", () => {
  it("indexes only when something is live", () => {
    expect(storefrontRobots([{ checkout_mode: "live" }])).toBeUndefined();
    expect(storefrontRobots([{ checkout_mode: "gated" }, { checkout_mode: "live" }])).toBeUndefined();
  });

  it.each([[[]], [[{ checkout_mode: "gated" }]], [[{ checkout_mode: null }]], [[{ checkout_mode: "sandbox" }, { checkout_mode: "paddle" }]]])(
    "noindex, nofollow for %j",
    (products) => {
      expect(storefrontRobots(products)).toEqual(NOINDEX);
      expect(NOINDEX).toEqual({ index: false, follow: false });
    },
  );
});

describe("insideItems (Sprint 17 P3)", () => {
  it("keeps well-formed {label, text} entries in order", () => {
    const items = [
      { label: "A", text: "first" },
      { label: "B", text: "second" },
    ];
    expect(insideItems(items)).toEqual(items);
  });

  it.each([null, undefined, "x", 42, {}])("returns [] for non-array %j", (raw) => {
    expect(insideItems(raw)).toEqual([]);
  });

  it("drops malformed entries", () => {
    expect(insideItems([null, "s", { label: "" , text: "t" }, { label: "L" }, { label: "L", text: 1 }, { label: "ok", text: "yes" }])).toEqual([
      { label: "ok", text: "yes" },
    ]);
  });
});
