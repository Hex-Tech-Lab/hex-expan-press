import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => null) }));

const productMock = vi.hoisted(() => ({
  creator: {
    handle: "expanpress_house",
    display_name: "ExpanPress",
    platform_handles: null,
    bio: null,
    photo: null,
    products: [],
  },
  product: {
    id: "00000000-0000-4000-8000-0000000000b3",
    store_product_id: "prod_sample",
    slug: "sample_the_quiet_workshop",
    title: "The Quiet Workshop (Sample)",
    price_usd: "9",
    currency: "USD",
    working_note: null,
    description: "Sample chapter.",
    disclaimers: [],
    checkout_mode: "live",
    inside: null,
  },
  origin: "https://expanpress.com",
}));

vi.mock("../../../../../src/components/storefront/storefront", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../src/components/storefront/storefront")>()),
  fetchStoreProduct: vi.fn(async () => productMock),
}));

import { GLOBAL } from "../../../../../../payments/src/settings_registry";
import StoreProductPage, { generateMetadata } from "../page";

const stripTags = (html: string) => html.replace(/<[^>]+>/g, "");

describe("store product page (/books/{handle}/{product})", () => {
  it("drops the trailing brand suffix in generateMetadata when creator display name is the brand itself", async () => {
    productMock.creator.display_name = GLOBAL.storefront.brand_name;
    const houseMeta = await generateMetadata({
      params: Promise.resolve({ handle: "expanpress_house", product: "sample_the_quiet_workshop" }),
    });
    expect(houseMeta.title).toBe("The Quiet Workshop (Sample) · ExpanPress");

    productMock.creator.display_name = "Ada";
    const creatorMeta = await generateMetadata({
      params: Promise.resolve({ handle: "ada", product: "sample_the_quiet_workshop" }),
    });
    expect(creatorMeta.title).toBe("The Quiet Workshop (Sample) · Ada · ExpanPress");
  });

  it("renders shared house vs creator sentence and shared BrandButton CTA classes", async () => {
    productMock.creator.display_name = GLOBAL.storefront.brand_name;
    productMock.creator.handle = "expanpress_house";
    const houseHtml = renderToStaticMarkup(
      await StoreProductPage({
        params: Promise.resolve({ handle: "expanpress_house", product: "sample_the_quiet_workshop" }),
      }),
    );
    expect(stripTags(houseHtml)).toContain("Published by ExpanPress");
    expect(houseHtml).not.toContain("creator-collaboration");
    expect(houseHtml).toContain("focus-visible:outline-[#E8622C]");
    expect(houseHtml).toContain("ExpanPress’s books");

    productMock.creator.display_name = "Ada";
    productMock.creator.handle = "ada";
    const creatorHtml = renderToStaticMarkup(
      await StoreProductPage({
        params: Promise.resolve({ handle: "ada", product: "sample_the_quiet_workshop" }),
      }),
    );
    expect(stripTags(creatorHtml)).toContain("A creator-collaboration publication with Ada");
    expect(creatorHtml).toContain(">Ada</a>");
    expect(stripTags(creatorHtml)).not.toContain("publication · with");
  });
});
