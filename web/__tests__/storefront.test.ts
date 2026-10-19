import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../src/components/storefront/storefront.css", () => ({}));
const supa = vi.hoisted(() => ({ client: null as null | { from: (table: string) => unknown } }));
vi.mock("../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => supa.client) }));

const { NOINDEX, fetchCreatorHub, insideItems, storefrontRobots } = await import("../src/components/storefront/storefront");

/** A Supabase stand-in answering the hub's two reads: the creator (with products) and system_config. */
function hubClient(creator: unknown) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === "creators" ? { data: creator, error: null } : { data: { value: "https://expanpress.com" }, error: null },
        }),
      }),
    }),
  };
}

const product = (id: string, checkout_mode: string) => ({
  id,
  store_product_id: `sp-${id}`,
  composite_slug: `duane/${id}`,
  site_slug: `duane/${id}`,
  slug: id,
  title: `Title ${id}`,
  price_usd: "39",
  currency: "USD",
  working_note: null,
  description: null,
  disclaimers: null,
  checkout_mode,
  inside: null,
});

describe("fetchCreatorHub lists only published (live) products", () => {
  it("renders and links only the live product, never a gated one", async () => {
    supa.client = hubClient({
      handle: "hubpub",
      display_name: "Duane",
      platform_handles: null,
      bio: null,
      photo: null,
      products: [product("live", "live"), product("draft", "gated")],
    });
    const hub = await fetchCreatorHub("hubpub");
    expect(hub?.creator.products.map((p) => p.id)).toEqual(["live"]);
  });

  it("keeps the robots result: gated-only stays noindex, a live product stays indexable", async () => {
    supa.client = hubClient({ handle: "hubdraft", display_name: "Duane", platform_handles: null, bio: null, photo: null, products: [product("draft", "gated")] });
    const draftHub = await fetchCreatorHub("hubdraft");
    expect(storefrontRobots(draftHub!.creator.products)).toEqual(NOINDEX);

    supa.client = hubClient({ handle: "hublive", display_name: "Duane", platform_handles: null, bio: null, photo: null, products: [product("live", "live")] });
    const liveHub = await fetchCreatorHub("hublive");
    expect(storefrontRobots(liveHub!.creator.products)).toBeUndefined();
  });
});

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
