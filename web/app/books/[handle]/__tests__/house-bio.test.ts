import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import * as storefront from "../../../../src/components/storefront/storefront";
import CreatorHubPage from "../page";
import { generateMetadata as productMetadata } from "../[product]/page";
import { generateMetadata as thanksMetadata } from "../thanks/page";

// Real implementations stay in place so the query-shape tests exercise them; the page tests override
// the resolved value per case.
vi.mock("../../../../src/components/storefront/storefront", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/components/storefront/storefront")>();
  return {
    ...actual,
    fetchCreatorHub: vi.fn(actual.fetchCreatorHub),
    fetchStoreProduct: vi.fn(actual.fetchStoreProduct),
    fetchCheckoutProduct: vi.fn(actual.fetchCheckoutProduct),
  };
});

// Records every select() column list per table, so the tests can assert the is_house column is requested.
const selects = vi.hoisted(() => new Map<string, string[]>());

vi.mock("../../../../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => ({
    from: (table: string) => ({
      select: (cols: string) => {
        selects.set(table, [...(selects.get(table) ?? []), cols]);
        return {
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        };
      },
    }),
  })),
}));

const brand = GLOBAL.storefront.brand_name;
const LIVE_PRODUCT_FOR_HUB = {
  id: "00000000-0000-4000-8000-0000000000c2",
  store_product_id: "prod_hub_live",
  slug: "hub_live_book",
  title: "Hub Live Book",
  price_usd: "39",
  currency: "USD",
  working_note: null,
  description: null,
  disclaimers: null,
  checkout_mode: "live",
  inside: null,
  book_registry: null,
  cover_image: null,
  is_sample: false,
};
const CHECKOUT_ID = "00000000-0000-4000-8000-0000000000c1";

function hubFor(overrides: { display_name: string; is_house: boolean }) {
  return {
    creator: {
      handle: "some_creator",
      display_name: overrides.display_name,
      platform_handles: null,
      bio: null,
      photo: null,
      is_house: overrides.is_house,
      // One live product so the hub is published (a hub with no visible product is 404 under hide_empty_creator_hubs).
      products: [LIVE_PRODUCT_FOR_HUB],
    },
    origin: "https://expanpress.com",
  };
}

// Only the fields the product metadata and robots helpers read; the cast keeps the fixture small.
const sampleProduct = {
  id: CHECKOUT_ID,
  store_product_id: "prod_sample",
  slug: "sample_book",
  title: "Sample Book",
  price_usd: "9",
  currency: "USD",
  working_note: null,
  description: null,
  disclaimers: null,
  checkout_mode: "live",
  inside: null,
  book_registry: null,
  cover_image: null,
  is_sample: false,
};

function productFor(overrides: { display_name: string; is_house: boolean }) {
  return {
    creator: { ...hubFor(overrides).creator, products: [sampleProduct] },
    product: sampleProduct,
    origin: "https://expanpress.com",
  };
}

async function renderHub(): Promise<string> {
  return renderToStaticMarkup(await CreatorHubPage({ params: Promise.resolve({ handle: "some_creator" }) }));
}

describe("isHouseCreator reads only the operator-set is_house flag", () => {
  it("is false for a creator that is not flagged, even when the display name is the brand", () => {
    expect(storefront.isHouseCreator({ is_house: false })).toBe(false);
  });

  it("is true for a flagged creator under any display name", () => {
    expect(storefront.isHouseCreator({ is_house: true })).toBe(true);
  });
});

describe("creator hub house bio is chosen by creators.is_house, not by display name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selects.clear();
  });

  it("a creator whose display name equals the brand but is_house is false gets no house bio", async () => {
    vi.mocked(storefront.fetchCreatorHub).mockResolvedValueOnce(hubFor({ display_name: brand, is_house: false }));
    const html = (await renderHub()).replace(/&#x27;/g, "'");
    expect(html).not.toContain(GLOBAL.storefront.house_creator_bio);
  });

  it("an operator-flagged house creator gets the house bio even under a different display name", async () => {
    vi.mocked(storefront.fetchCreatorHub).mockResolvedValueOnce(hubFor({ display_name: "Alice Smith", is_house: true }));
    const html = (await renderHub()).replace(/&#x27;/g, "'");
    expect(html).toContain(GLOBAL.storefront.house_creator_bio);
  });

  it("the creator hub query selects the is_house column", async () => {
    // The real fetchCreatorHub runs against the mocked admin client and returns null (no creator row).
    await storefront.fetchCreatorHub("some_creator");
    expect(selects.get("creators")?.some((cols) => cols.includes("is_house"))).toBe(true);
  });
});

describe("product page title uses the house flag, not the display name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a flagged house product is titled without a creator segment", async () => {
    vi.mocked(storefront.fetchStoreProduct).mockResolvedValueOnce(
      productFor({ display_name: "Alice Smith", is_house: true }) as never,
    );
    const meta = await productMetadata({ params: Promise.resolve({ handle: "some_creator", product: "sample_book" }) });
    expect(meta.title).toBe(`Sample Book · ${brand}`);
  });

  it("a creator who names themselves after the brand, without the flag, keeps the creator segment", async () => {
    vi.mocked(storefront.fetchStoreProduct).mockResolvedValueOnce(
      productFor({ display_name: brand, is_house: false }) as never,
    );
    const meta = await productMetadata({ params: Promise.resolve({ handle: "some_creator", product: "sample_book" }) });
    expect(meta.title).toBe(`Sample Book · ${brand} · ${brand}`);
  });

  it("the checkout product query selects the creator is_house column", async () => {
    await storefront.fetchCheckoutProduct(CHECKOUT_ID);
    expect(selects.get("products")?.some((cols) => cols.includes("creators(handle, display_name, is_house)"))).toBe(true);
  });
});

describe("thank-you page title uses the house flag, not the display name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a flagged house creator gets the house thank-you title", async () => {
    vi.mocked(storefront.fetchCreatorHub).mockResolvedValueOnce(hubFor({ display_name: "Alice Smith", is_house: true }));
    const meta = await thanksMetadata({ params: Promise.resolve({ handle: "some_creator" }) });
    expect(meta.title).toBe(`Thank you · ${brand}`);
  });

  it("an external creator gets their own name in the thank-you title", async () => {
    vi.mocked(storefront.fetchCreatorHub).mockResolvedValueOnce(hubFor({ display_name: "Alice Smith", is_house: false }));
    const meta = await thanksMetadata({ params: Promise.resolve({ handle: "some_creator" }) });
    expect(meta.title).toBe(`Thank you · Alice Smith · ${brand}`);
  });

  it("a creator named after the brand without the flag keeps their name in the title", async () => {
    vi.mocked(storefront.fetchCreatorHub).mockResolvedValueOnce(hubFor({ display_name: brand, is_house: false }));
    const meta = await thanksMetadata({ params: Promise.resolve({ handle: "some_creator" }) });
    expect(meta.title).toBe(`Thank you · ${brand} · ${brand}`);
  });
});

describe("publication byline uses the house flag, not the display name", () => {
  it("renders the house sentence when creatorIsHouse is true", () => {
    const html = renderToStaticMarkup(
      createElement(storefront.PublicationByline, {
        creatorHandle: "some_creator",
        creatorDisplayName: "Alice Smith",
        creatorIsHouse: true,
      }),
    );
    expect(html).toContain("Published by");
  });

  it("renders the collaboration sentence for a non-house creator named after the brand", () => {
    const html = renderToStaticMarkup(
      createElement(storefront.PublicationByline, {
        creatorHandle: "some_creator",
        creatorDisplayName: brand,
        creatorIsHouse: false,
      }),
    );
    expect(html).toContain("A creator-collaboration publication with");
    expect(html).not.toContain("Published by");
  });
});
