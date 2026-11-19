import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const supa = vi.hoisted(() => ({ client: null as null | { from: (table: string) => unknown } }));
vi.mock("../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => supa.client) }));

const { NOINDEX, fetchB2cLanding, fetchCreatorHub, fetchStoreProduct, insideItems, productSlugOf, storefrontRobots } = await import(
  "../src/components/storefront/storefront"
);

describe("StorefrontFooter buyer legal links", () => {
  it("shows the buyer legal links by default and hides them on a gated (draft) product page", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { StorefrontFooter } = await import("../src/components/storefront/storefront");

    const live = renderToStaticMarkup(createElement(StorefrontFooter));
    expect(live).toContain("/books/legal/terms.html");
    expect(live).toContain("/books/legal/refund-policy.html");

    const gated = renderToStaticMarkup(createElement(StorefrontFooter, { showBuyerLegal: false }));
    expect(gated).not.toContain("/books/legal/");
    expect(gated).toContain("Support: support@expanpress.com");
  });
});

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

describe("B2C landing query filters live products in PostgREST and selects only landing fields", () => {
  /** Records each builder call; awaiting the builder resolves to `rows`, as PostgREST would. */
  function landingDb(rows: unknown[]) {
    const calls: unknown[][] = [];
    const q: Record<string, unknown> = {};
    for (const method of ["eq", "not", "neq"]) {
      q[method] = (...args: unknown[]) => {
        calls.push([method, ...args]);
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    supa.client = {
      from: (table: string) => {
        calls.push(["from", table]);
        return {
          select: (cols: string) => {
            calls.push(["select", cols]);
            return q;
          },
        };
      },
    };
    return calls;
  }

  it("asks PostgREST for live commercial products only and selects no detail fields", async () => {
    const calls = landingDb([{ handle: "duane", display_name: "Duane", products: [product("live", "live")] }]);
    await fetchB2cLanding();
    const select = calls.find((c) => c[0] === "select")?.[1] as string;
    expect(select).toContain("products!inner(");
    for (const detail of ["description", "disclaimers", "inside", "currency", "working_note", "composite_slug"]) {
      expect(select, detail).not.toContain(detail);
    }
    expect(calls).toContainEqual(["eq", "products.checkout_mode", "live"]);
    expect(calls).toContainEqual(["neq", "products.store_product_id", ""]);
  });

  it("returns only creators with a live product, and only that product", async () => {
    landingDb([
      { handle: "duane", display_name: "Duane", products: [product("live", "live"), product("draft", "gated")] },
      { handle: "onlydraft", display_name: "Draft Only", products: [product("d2", "gated")] },
    ]);
    const creators = await fetchB2cLanding();
    expect(creators.map((c) => c.handle)).toEqual(["duane"]);
    expect(creators[0].products.map((p) => p.id)).toEqual(["live"]);
  });
});

describe("product slug comes from products.slug only (F-01)", () => {
  it("resolves a product by its creator handle and products.slug", async () => {
    const hyphenated = {
      ...product("500k_playbook", "live"),
      slug: "500k_playbook",
    };
    expect(productSlugOf(hyphenated)).toBe("500k_playbook");
    supa.client = hubClient({
      handle: "retirearly500k",
      display_name: "Duane",
      platform_handles: null,
      bio: null,
      photo: null,
      products: [hyphenated],
    });
    const found = await fetchStoreProduct("retirearly500k", "500k_playbook");
    expect(found?.product.id).toBe("500k_playbook");
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
