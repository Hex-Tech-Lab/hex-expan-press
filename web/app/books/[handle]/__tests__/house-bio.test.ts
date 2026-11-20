import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import * as storefront from "../../../../src/components/storefront/storefront";
import CreatorHubPage from "../page";

// fetchCreatorHub keeps its real implementation so the query-shape test exercises it; the page tests
// override the resolved value per case.
vi.mock("../../../../src/components/storefront/storefront", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/components/storefront/storefront")>();
  return { ...actual, fetchCreatorHub: vi.fn(actual.fetchCreatorHub) };
});

const selectMock = vi.fn();

vi.mock("../../../../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => ({
    from: (table: string) => {
      if (table !== "creators") throw new Error(`unexpected table ${table}`);
      return {
        select: (cols: string) => {
          selectMock(cols);
          return {
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          };
        },
      };
    },
  })),
}));

function hubFor(overrides: { display_name: string; is_house: boolean }) {
  return {
    creator: {
      handle: "some_creator",
      display_name: overrides.display_name,
      platform_handles: null,
      bio: null,
      photo: null,
      is_house: overrides.is_house,
      products: [],
    },
    origin: "https://expanpress.com",
  };
}

async function renderHub(): Promise<string> {
  return renderToStaticMarkup(await CreatorHubPage({ params: Promise.resolve({ handle: "some_creator" }) }));
}

describe("creator hub house bio is chosen by creators.is_house, not by display name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a creator whose display name equals the brand but is_house is false gets no house bio", async () => {
    vi.mocked(storefront.fetchCreatorHub).mockResolvedValueOnce(
      hubFor({ display_name: GLOBAL.storefront.brand_name, is_house: false }),
    );
    const html = (await renderHub()).replace(/&#x27;/g, "'");
    expect(html).not.toContain(GLOBAL.storefront.house_creator_bio);
  });

  it("an operator-flagged house creator gets the house bio even under a different display name", async () => {
    vi.mocked(storefront.fetchCreatorHub).mockResolvedValueOnce(
      hubFor({ display_name: "Alice Smith", is_house: true }),
    );
    const html = (await renderHub()).replace(/&#x27;/g, "'");
    expect(html).toContain(GLOBAL.storefront.house_creator_bio);
  });

  it("the creator query selects the is_house column", async () => {
    // The real fetchCreatorHub runs against the mocked admin client and returns null (no creator row).
    const actual = vi.mocked(storefront.fetchCreatorHub).getMockImplementation();
    expect(actual).toBeDefined();
    await actual!("some_creator");
    expect(selectMock).toHaveBeenCalledWith(expect.stringContaining("is_house"));
  });
});
