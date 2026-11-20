import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import CreatorHubPage, { generateMetadata } from "../page";

// next/navigation notFound() throws in a real render; mirror that so the test can assert it.
vi.mock("next/navigation", () => ({
  notFound: () => {
    const err = new Error("NEXT_NOT_FOUND");
    (err as unknown as { digest: string }).digest = "NEXT_HTTP_ERROR_FALLBACK;404";
    throw err;
  },
  redirect: () => {
    throw new Error("unexpected redirect");
  },
}));

// Real fetchCreatorHub runs against this mocked admin client, so the visibility predicate is exercised end to end.
const creators = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("../../../../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, value: string) => ({
          maybeSingle: async () => {
            if (table === "creators") return { data: creators.get(value) ?? null, error: null };
            return { data: null, error: null };
          },
        }),
      }),
    }),
  })),
}));

const brand = GLOBAL.storefront.brand_name;

function product(overrides: { slug: string; title: string; checkout_mode: string; store_product_id?: string }) {
  return {
    id: `id_${overrides.slug}`,
    store_product_id: overrides.store_product_id ?? `prod_${overrides.slug}`,
    slug: overrides.slug,
    title: overrides.title,
    price_usd: "39",
    currency: "USD",
    working_note: null,
    description: null,
    disclaimers: null,
    checkout_mode: overrides.checkout_mode,
    inside: null,
    book_registry: null,
    product_rails: [],
  };
}

function seed(handle: string, displayName: string, isHouse: boolean, products: ReturnType<typeof product>[]) {
  creators.set(handle, {
    handle,
    display_name: displayName,
    platform_handles: null,
    bio: null,
    photo: null,
    is_house: isHouse,
    products,
  });
}

async function renderHub(handle: string): Promise<string> {
  return renderToStaticMarkup(await CreatorHubPage({ params: Promise.resolve({ handle }) }));
}

const originalFlag = GLOBAL.storefront.hide_empty_creator_hubs;

beforeEach(() => {
  creators.clear();
  (GLOBAL.storefront as { hide_empty_creator_hubs: boolean }).hide_empty_creator_hubs = true;
});

afterEach(() => {
  (GLOBAL.storefront as { hide_empty_creator_hubs: boolean }).hide_empty_creator_hubs = originalFlag;
});

describe("creator hub with no visible storefront product", () => {
  it("a hub whose only products are hidden gated books gives notFound (404)", async () => {
    seed("empty_hub_gated", "Real Name Person", false, [
      product({ slug: "hidden_gated", title: "Hidden Gated Book", checkout_mode: "gated" }),
    ]);
    await expect(renderHub("empty_hub_gated")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("generateMetadata for the same hub gives notFound and never puts the creator name in a title", async () => {
    seed("empty_hub_meta", "Real Name Person", false, [
      product({ slug: "hidden_meta", title: "Hidden Meta Book", checkout_mode: "gated" }),
    ]);
    await expect(generateMetadata({ params: Promise.resolve({ handle: "empty_hub_meta" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("a hub with one visible live product renders the shelf", async () => {
    seed("one_visible", "Visible Person", false, [
      product({ slug: "live_book", title: "Live Book Title", checkout_mode: "live" }),
    ]);
    const html = await renderHub("one_visible");
    expect(html).toContain("Live Book Title");
    expect(html).not.toContain("No books are on sale yet");
  });

  it("the house hub with no visible product still renders (unchanged)", async () => {
    seed("expanpress_house", brand, true, [
      product({ slug: "house_gated", title: "House Gated Title", checkout_mode: "gated" }),
    ]);
    const html = await renderHub("expanpress_house");
    expect(html).toContain("No books are on sale yet");
  });

  it("with hide_empty_creator_hubs false the empty shelf renders as before", async () => {
    (GLOBAL.storefront as { hide_empty_creator_hubs: boolean }).hide_empty_creator_hubs = false;
    seed("flag_off_hub", "Flag Off Person", false, [
      product({ slug: "flag_off_gated", title: "Flag Off Gated", checkout_mode: "gated" }),
    ]);
    const html = await renderHub("flag_off_hub");
    expect(html).toContain("No books are on sale yet");
  });
});
