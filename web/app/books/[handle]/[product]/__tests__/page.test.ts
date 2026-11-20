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
    preview_pdf: null as string | null,
    overview: undefined as string | null | undefined,
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

  it("renders book overview from the book identity SSOT and omits it when absent", async () => {
    productMock.creator.display_name = GLOBAL.storefront.brand_name;
    productMock.creator.handle = "expanpress_house";
    productMock.product.overview = undefined;
    const sampleHtml = renderToStaticMarkup(
      await StoreProductPage({
        params: Promise.resolve({ handle: "expanpress_house", product: "sample_the_quiet_workshop" }),
      }),
    );
    expect(sampleHtml).toContain('data-testid="book-overview"');
    expect(stripTags(sampleHtml)).toContain("Setting Up the Bench");
    expect(stripTags(sampleHtml).toLowerCase()).toContain("sample");

    productMock.product.overview = null;
    const withoutOverviewHtml = renderToStaticMarkup(
      await StoreProductPage({
        params: Promise.resolve({ handle: "expanpress_house", product: "sample_the_quiet_workshop" }),
      }),
    );
    expect(withoutOverviewHtml).not.toContain('data-testid="book-overview"');
    productMock.product.overview = undefined;
  });

  it("renders the preview scroll cue arrow only when preview_pdf is present and binds layout spacing from settings_registry", async () => {
    productMock.creator.display_name = GLOBAL.storefront.brand_name;
    productMock.creator.handle = "expanpress_house";
    const layout = GLOBAL.storefront.product_layout;

    productMock.product.preview_pdf = null;
    const withoutPreview = renderToStaticMarkup(
      await StoreProductPage({
        params: Promise.resolve({ handle: "expanpress_house", product: "sample_the_quiet_workshop" }),
      }),
    );
    expect(withoutPreview).not.toContain('data-testid="preview-scroll-cue"');
    expect(withoutPreview).not.toContain('data-testid="book-preview-section"');

    productMock.product.preview_pdf = "/books/previews/sample_the_quiet_workshop.pdf";
    const withPreview = renderToStaticMarkup(
      await StoreProductPage({
        params: Promise.resolve({ handle: "expanpress_house", product: "sample_the_quiet_workshop" }),
      }),
    );
    expect(withPreview).toContain('data-testid="preview-scroll-cue"');
    expect(withPreview).toContain(`aria-controls="${layout.preview_section_id}"`);
    expect(stripTags(withPreview)).toContain(layout.preview_cue_label);
    expect(withPreview).toContain(`id="${layout.preview_section_id}"`);
    expect(withPreview).toContain(`--product-gap-desktop:${layout.gap_desktop_px}px`);
    expect(withPreview).toContain(`--product-cover-max-w:${layout.cover_max_width_px}px`);
    expect(withPreview).toContain('data-testid="product-cover-col"');
    expect(withPreview).toContain('data-testid="product-details-card"');
    expect(withPreview).toContain("md:h-0 md:min-h-full");
    expect(withPreview).toContain('data-testid="book-overview-scroll"');
    expect(withPreview).toContain("thin-scrollbar");
    expect(withPreview).toContain('tabindex="0"');
    productMock.product.preview_pdf = null;
  });

  it("always shows buyer legal links (privacy, terms, refund) on gated sample pages when always_show_buyer_legal is true (LV-03)", async () => {
    const origMode = productMock.product.checkout_mode;
    const origHandle = productMock.creator.handle;
    const origName = productMock.creator.display_name;
    productMock.creator.handle = "expanpress_house";
    productMock.creator.display_name = GLOBAL.storefront.brand_name;
    productMock.product.checkout_mode = "gated";
    try {
      const html = renderToStaticMarkup(
        await StoreProductPage({
          params: Promise.resolve({ handle: "expanpress_house", product: "sample_the_quiet_workshop" }),
        }),
      );
      expect(html).toContain('data-checkout-mode="gated"');
      expect(html).toContain('/books/legal/privacy.html');
      expect(html).toContain('/books/legal/terms.html');
      expect(html).toContain('/books/legal/refund-policy.html');
      expect(html).toContain(GLOBAL.email.support);
    } finally {
      productMock.product.checkout_mode = origMode;
      productMock.creator.handle = origHandle;
      productMock.creator.display_name = origName;
    }
  });
});
