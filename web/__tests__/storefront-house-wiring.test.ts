import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const supa = vi.hoisted(() => ({ client: null as null | { from: (table: string) => unknown } }));
vi.mock("../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => supa.client) }));

const { fetchB2cLanding, fetchCreatorHub, fetchStoreProduct } = await import("../src/components/storefront/storefront");

const HOUSE_SAMPLE_PRODUCT_ID = "9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc";
const UNRELATED_PRODUCT_ID = "00000000-0000-4000-8000-0000000000ff";

/** Records the columns passed to the creators select, and answers the creators and system_config reads. */
function recordingClient(creatorData: unknown) {
  const creatorSelects: string[] = [];
  const result = (data: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ["eq", "in", "not", "neq"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data, error: null });
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve, reject);
    return q;
  };
  supa.client = {
    from: (table: string) => ({
      select: (cols: string) => {
        if (table === "creators") {
          creatorSelects.push(cols);
          return result(creatorData);
        }
        return result({ value: "https://expanpress.com" });
      },
    }),
  };
  return creatorSelects;
}

const sampleProduct = (id: string) => ({
  id,
  store_product_id: `sp-${id}`,
  slug: "sample_the_quiet_workshop",
  title: "The Quiet Workshop (Sample)",
  price_usd: "9",
  currency: "USD",
  working_note: null,
  description: null,
  disclaimers: null,
  checkout_mode: "gated",
  inside: null,
  book_registry: "books/sample_the_quiet_workshop.json",
});

describe("non-house creator products never receive house assets through the product page", () => {
  it("gives a non-house product with the house sample slug, title and registry no cover, no preview, and is_sample false", async () => {
    recordingClient({
      handle: "wirenonhouse",
      display_name: "Creator",
      platform_handles: null,
      bio: null,
      photo: null,
      is_house: false,
      products: [sampleProduct(UNRELATED_PRODUCT_ID)],
    });
    const found = await fetchStoreProduct("wirenonhouse", "sample_the_quiet_workshop");
    expect(found).not.toBeNull();
    expect(found?.product.cover_image).toBeNull();
    expect(found?.product.preview_pdf).toBeNull();
    expect(found?.product.is_sample).toBe(false);
    expect(found?.product.overview).toBeNull();
  });

  it("keeps house assets for the house product through the same page path", async () => {
    recordingClient({
      handle: "expanpress_house",
      display_name: "ExpanPress",
      platform_handles: null,
      bio: null,
      photo: null,
      is_house: true,
      products: [sampleProduct("33333333-0000-4000-8000-000000000001")],
    });
    const found = await fetchStoreProduct("expanpress_house", "sample_the_quiet_workshop");
    expect(found?.product.cover_image).toBe("/books/covers/sample_the_quiet_workshop.webp");
    expect(found?.product.is_sample).toBe(true);
  });

  it("keeps the exact product_id identity match for a non-house product that is the house sample product", async () => {
    recordingClient({
      handle: "wireidentity",
      display_name: "Creator",
      platform_handles: null,
      bio: null,
      photo: null,
      is_house: false,
      products: [sampleProduct(HOUSE_SAMPLE_PRODUCT_ID)],
    });
    const found = await fetchStoreProduct("wireidentity", "sample_the_quiet_workshop");
    expect(found?.product.is_sample).toBe(true);
    expect(found?.product.cover_image).toBe("/books/covers/sample_the_quiet_workshop.webp");
  });
});

describe("select strings carry the fields the house gate needs", () => {
  it("selects creators.is_house and product id on the creator hub and product page queries", async () => {
    const hubSelects = recordingClient({
      handle: "selecthub",
      display_name: "Creator",
      platform_handles: null,
      bio: null,
      photo: null,
      is_house: false,
      products: [sampleProduct(UNRELATED_PRODUCT_ID)],
    });
    await fetchCreatorHub("selecthub");
    expect(hubSelects.length).toBeGreaterThan(0);
    for (const cols of hubSelects) {
      expect(cols).toContain("is_house");
      expect(cols).toContain("products(id");
    }

    const pageSelects = recordingClient({
      handle: "selectpage",
      display_name: "Creator",
      platform_handles: null,
      bio: null,
      photo: null,
      is_house: false,
      products: [sampleProduct(UNRELATED_PRODUCT_ID)],
    });
    await fetchStoreProduct("selectpage", "sample_the_quiet_workshop");
    for (const cols of pageSelects) {
      expect(cols).toContain("is_house");
      expect(cols).toContain("products(id");
    }
  });

  it("selects creators.is_house and product id on the B2C landing query", async () => {
    const landingSelects = recordingClient([
      {
        handle: "selectlanding",
        display_name: "Creator",
        is_house: false,
        products: [{ ...sampleProduct(UNRELATED_PRODUCT_ID), checkout_mode: "live" }],
      },
    ]);
    await fetchB2cLanding();
    expect(landingSelects.length).toBeGreaterThan(0);
    for (const cols of landingSelects) {
      expect(cols).toContain("is_house");
      expect(cols).toContain("products!inner(id");
    }
  });
});
