import { describe, expect, it, vi } from "vitest";
import { GLOBAL } from "../../payments/src/settings_registry";

vi.mock("server-only", () => ({}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: sentry.captureException }));
const supa = vi.hoisted(() => ({ client: null as null | { from: (table: string) => unknown } }));
vi.mock("../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => supa.client) }));

const {
  BookCard,
  BookCover,
  NOINDEX,
  fetchB2cLanding,
  fetchCreatorHub,
  fetchStoreProduct,
  formatCoverFooterTitle,
  insideItems,
  productSlugOf,
  storefrontRobots,
  usableRailsForRows,
} = await import("../src/components/storefront/storefront");

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
    expect(gated).toContain(GLOBAL.email.support);
    expect(gated).not.toContain("Support:");
  });
});

describe("BookCard and formatProductPrice currency formatting (B-10)", () => {
  it("formats non-USD product currency instead of hard-coding $ and USD", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { BookCard, formatProductPrice } = await import("../src/components/storefront/storefront");

    expect(formatProductPrice(19, "EUR")).toEqual({ formatted: "€19.00", currency: "EUR" });
    expect(formatProductPrice(19, null)).toEqual({ formatted: "$19.00", currency: GLOBAL.defaults.currency });

    const html = renderToStaticMarkup(
      createElement(BookCard, {
        product: { slug: "euro_book", title: "Euro Book", price_usd: "19", currency: "EUR" },
        creatorHandle: "ada",
        creatorName: "Ada",
      }),
    );
    expect(html).toContain("€19.00");
    expect(html).toContain("EUR · one-time");
    expect(html).not.toContain("USD · one-time");
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

describe("fetchCreatorHub lists published (live) products + allowed non-live samples only", () => {
  it("renders and links live products and sample gated products, never a non-sample gated one", async () => {
    supa.client = hubClient({
      handle: "hubpub",
      display_name: "Duane",
      platform_handles: null,
      bio: null,
      photo: null,
      products: [
        product("live", "live"),
        { ...product("draft", "gated"), book_registry: "books/duane.json" },
      ],
    });
    const hub = await fetchCreatorHub("hubpub");
    expect(hub?.creator.products.map((p) => p.id)).toEqual(["live"]);

    supa.client = hubClient({
      handle: "expanpress_house",
      display_name: "ExpanPress",
      platform_handles: null,
      bio: null,
      photo: null,
      is_house: true,
      products: [
        {
          ...product("sample_the_quiet_workshop", "gated"),
          title: "The Quiet Workshop (Sample)",
          book_registry: "books/sample_the_quiet_workshop.json",
        },
      ],
    });
    const houseHub = await fetchCreatorHub("expanpress_house");
    expect(houseHub?.creator.products.map((p) => p.id)).toEqual(["sample_the_quiet_workshop"]);
    expect(houseHub?.creator.products[0]?.is_sample).toBe(true);
    expect(storefrontRobots(houseHub!.creator.products)).toEqual(NOINDEX);
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

describe("house assets only for house creators: a non-house product cannot claim the house sample", () => {
  it("hides a non-house gated product that copies the house sample slug, title and registry", async () => {
    supa.client = hubClient({
      handle: "hubimpostor",
      display_name: "Impostor",
      platform_handles: null,
      bio: null,
      photo: null,
      is_house: false,
      products: [
        {
          ...product("sample_the_quiet_workshop", "gated"),
          title: "The Quiet Workshop (Sample)",
          book_registry: "books/sample_the_quiet_workshop.json",
        },
      ],
    });
    const hub = await fetchCreatorHub("hubimpostor");
    expect(hub).not.toBeNull();
    expect(hub?.creator.products.map((p) => p.id)).toEqual([]);
  });
});

describe("is_sample is explicit: a non-sample with a sample-like slug and title is never listed", () => {
  it("hides a gated product whose slug starts with sample_ and title ends (Sample) when books/*.json says is_sample false", async () => {
    supa.client = hubClient({
      handle: "hublookalike",
      display_name: "Duane",
      platform_handles: null,
      bio: null,
      photo: null,
      products: [
        { ...product("sample_lookalike", "gated"), title: "Lookalike (Sample)", book_registry: "books/duane.json" },
      ],
    });
    const hub = await fetchCreatorHub("hublookalike");
    expect(hub).not.toBeNull();
    expect(hub?.creator.products.map((p) => p.id)).toEqual([]);
  });
});

describe("B2C landing query filters live + allowed non-live sample products only", () => {
  /** Records each builder call; awaiting the builder resolves to `rows`, as PostgREST would. */
  function landingDb(rows: unknown[]) {
    const calls: unknown[][] = [];
    const q: Record<string, unknown> = {};
    for (const method of ["eq", "in", "not", "neq"]) {
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

  it("asks PostgREST for live + allowed non-live sample modes and selects no detail fields", async () => {
    const calls = landingDb([{ handle: "duane", display_name: "Duane", products: [product("live", "live")] }]);
    await fetchB2cLanding();
    const select = calls.find((c) => c[0] === "select")?.[1] as string;
    expect(select).toContain("products!inner(");
    for (const detail of ["description", "disclaimers", "inside", "currency", "working_note", "composite_slug"]) {
      expect(select, detail).not.toContain(detail);
    }
    expect(calls).toContainEqual(["in", "products.checkout_mode", ["live", "gated"]]);
    expect(calls).toContainEqual(["neq", "products.store_product_id", ""]);
  });

  it("lists live products and gated SAMPLE products (is_sample from book registry), while keeping non-sample gated products hidden", async () => {
    landingDb([
      {
        handle: "duane",
        display_name: "Duane",
        products: [
          product("live", "live"),
          { ...product("500k_playbook", "gated"), book_registry: "books/duane.json" },
        ],
      },
      {
        handle: "onlydraft",
        display_name: "Draft Only",
        products: [
          product("d2", "gated"),
          { ...product("duane_gated", "gated"), book_registry: "books/duane.json" },
        ],
      },
      {
        handle: "expanpress_house",
        display_name: "ExpanPress",
        is_house: true,
        products: [
          {
            ...product("sample_the_quiet_workshop", "gated"),
            title: "The Quiet Workshop (Sample)",
            book_registry: "books/sample_the_quiet_workshop.json",
          },
        ],
      },
    ]);
    const creators = await fetchB2cLanding();
    expect(creators.map((c) => c.handle)).toEqual(["duane", "expanpress_house"]);
    expect(creators[0].products.map((p) => p.id)).toEqual(["live"]);
    expect(creators[1].products.map((p) => p.id)).toEqual(["sample_the_quiet_workshop"]);
    expect(creators[1].products[0]?.is_sample).toBe(true);
  });

  it("hides gated samples and queries live-only when show_non_live_samples is disabled", async () => {
    const orig = GLOBAL.storefront.show_non_live_samples;
    GLOBAL.storefront.show_non_live_samples = false;
    try {
      const calls = landingDb([
        {
          handle: "expanpress_house",
          display_name: "ExpanPress",
          is_house: true,
          products: [
            {
              ...product("sample_the_quiet_workshop", "gated"),
              book_registry: "books/sample_the_quiet_workshop.json",
            },
          ],
        },
      ]);
      const creators = await fetchB2cLanding();
      expect(calls).toContainEqual(["eq", "products.checkout_mode", "live"]);
      expect(creators).toEqual([]);
    } finally {
      GLOBAL.storefront.show_non_live_samples = orig;
    }
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

describe("buyer-facing 'Coming soon' state: data-checkout-mode names the reason, and Sentry fires only for malformed rails", () => {
  const card = async (product: Record<string, unknown>) => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    return renderToStaticMarkup(
      createElement(BookCard, {
        product: { slug: "b", title: "B", cover_image: null, is_sample: false, ...product } as never,
        creatorHandle: "h",
        creatorName: "H",
      }),
    );
  };

  it("a priced live product with no usable rail is labelled no_rail (a designed state, not an unpriced one)", async () => {
    const html = await card({ price_usd: "29", checkout_mode: "live", usable_rail_count: 0 });
    expect(html).toContain('data-checkout-mode="no_rail"');
    expect(html).not.toContain('data-checkout-mode="unpriced"');
  });

  it("a live product with no price is labelled unpriced", async () => {
    const html = await card({ price_usd: null, checkout_mode: "live", usable_rail_count: 1 });
    expect(html).toContain('data-checkout-mode="unpriced"');
  });

  it("zero usable rails is a designed state: no Sentry capture", () => {
    sentry.captureException.mockClear();
    expect(usableRailsForRows([], "live")).toEqual([]);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("malformed rails still report to Sentry (the one place the incident is counted)", () => {
    sentry.captureException.mockClear();
    expect(usableRailsForRows([null], "live")).toEqual([]);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
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

describe("BookCover and BookCard layout, cover aspect ratio, and (Sample) footer", () => {
  it("strips any trailing (Sample) from title when rendering the sample badge so it never duplicates", () => {
    expect(formatCoverFooterTitle("The Quiet Workshop (Sample)", true, "(Sample)")).toEqual({
      baseTitle: "The Quiet Workshop",
      sampleBadge: "(Sample)",
    });
    expect(formatCoverFooterTitle("The Quiet Workshop", true, "(Sample)")).toEqual({
      baseTitle: "The Quiet Workshop",
      sampleBadge: "(Sample)",
    });
    expect(formatCoverFooterTitle("Full Book", false, "(Sample)")).toEqual({
      baseTitle: "Full Book",
      sampleBadge: null,
    });
  });

  it("renders DIGITAL PDF header strip, aspect-preserving cover image (object-contain), and footer strip", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");

    const html = renderToStaticMarkup(
      createElement(BookCover, {
        title: "The Quiet Workshop (Sample)",
        coverImage: "/books/covers/sample_the_quiet_workshop.webp",
        isSample: true,
      }),
    );
    expect(html).toContain("DIGITAL PDF");
    expect(html).toContain('src="/books/covers/sample_the_quiet_workshop.webp"');
    expect(html).toContain("object-contain");
    expect(html).not.toContain("object-cover");
    expect(html).toContain("The Quiet Workshop");
    expect(html).toContain("(Sample)");
    expect(html).not.toContain("(Sample) (Sample)");
    const imgStart = html.lastIndexOf("<img");
    const footerSlice = html.slice(html.indexOf(">", imgStart) + 1);
    expect(footerSlice.match(/\(Sample\)/g)?.length).toBe(1);
    expect(html).toContain("ExpanPress");
  });

  it("renders BookCard with typographic fallback when no cover image is present", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");

    const html = renderToStaticMarkup(
      createElement(BookCard, {
        product: {
          slug: "e2e_live_book",
          title: "E2E Live Book",
          price_usd: "29",
          cover_image: null,
          is_sample: false,
          checkout_mode: "live",
          usable_rail_count: 1,
        },
        creatorHandle: "e2e_live_creator",
        creatorName: "E2E Live Creator",
      }),
    );
    expect(html).toContain("DIGITAL PDF");
    expect(html).not.toContain("<img");
    expect(html).toContain("E2E Live Book");
    expect(html).not.toContain("(Sample)");
    expect(html).not.toContain(GLOBAL.storefront.coming_soon_badge);
    expect(html).toContain("ExpanPress");
    expect(html).toContain("$29.00");
  });

  it("renders coming-soon pill and preview CTA linking to product page on non-live sample BookCard", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");

    const html = renderToStaticMarkup(
      createElement(BookCard, {
        product: {
          slug: "sample_the_quiet_workshop",
          title: "The Quiet Workshop (Sample)",
          price_usd: "9.00",
          cover_image: "/books/covers/sample_the_quiet_workshop.webp",
          is_sample: true,
          checkout_mode: "gated",
        },
        creatorHandle: "expanpress_house",
        creatorName: "ExpanPress",
      }),
    );
    expect(html).toContain(GLOBAL.storefront.coming_soon_badge);
    expect(html).toContain('data-checkout-mode="gated"');
    expect(html).toContain(GLOBAL.storefront.sample_preview_cta);
    expect(html).toContain('href="/books/expanpress_house/sample_the_quiet_workshop"');
  });

  it("fetchB2cLanding and fetchStoreProduct enrich products with cover_image, preview_pdf, and is_sample", async () => {
    supa.client = hubClient({
      handle: "expanpress_house",
      display_name: "ExpanPress",
      platform_handles: null,
      bio: null,
      photo: null,
      is_house: true,
      products: [
        {
          ...product("sample_the_quiet_workshop", "live"),
          title: "The Quiet Workshop (Sample)",
          book_registry: "books/sample_the_quiet_workshop.json",
        },
      ],
    });
    const found = await fetchStoreProduct("expanpress_house", "sample_the_quiet_workshop");
    expect(found?.product.cover_image).toBe("/books/covers/sample_the_quiet_workshop.webp");
    expect(found?.product.preview_pdf).toBe("/books/previews/sample_the_quiet_workshop.pdf");
    expect(found?.product.is_sample).toBe(true);
    expect(found?.product.overview).toContain("Setting Up the Bench");
  });
});
