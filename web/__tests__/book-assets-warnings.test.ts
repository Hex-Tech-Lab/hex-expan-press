import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL } from "../../payments/src/settings_registry";
import { resolveProductBookAssets } from "../src/lib/book-assets";

const DUANE_PRODUCT_ID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const HOUSE_SAMPLE_PRODUCT_ID = "9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("book-assets warnings for impersonation and missing assets", () => {
  it("warns once when a non-house product resolves to a books json that names another product", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const product = {
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      slug: "impostor_one",
      book_registry: "books/sample_the_quiet_workshop.json",
      creator_is_house: false,
    };
    const first = resolveProductBookAssets(product);
    resolveProductBookAssets(product);
    expect(first).toMatchObject({ cover_image: null, preview_pdf: null, is_sample: false });
    const messages = warn.mock.calls.map((c) => String(c[0]));
    const hits = messages.filter((m) => m.includes("aaaaaaaa-0000-4000-8000-000000000001") && m.includes("names another product"));
    expect(hits).toHaveLength(1);
  });

  it("stays silent for a non-house product whose own registry names its own product id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveProductBookAssets({
      id: DUANE_PRODUCT_ID,
      slug: "retirearly500k",
      book_registry: "books/duane.json",
      creator_is_house: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent for a non-house product whose own registry file has no product_id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveProductBookAssets({
      id: "bbbbbbbb-0000-4000-8000-000000000002",
      slug: "own_registry_no_identity",
      book_registry: "books/smoke.json",
      creator_is_house: false,
    });
    const hits = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("bbbbbbbb-0000-4000-8000-000000000002"));
    expect(hits).toHaveLength(0);
  });

  it("warns for a non-house product that names the house sample's product id but resolves to a different file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveProductBookAssets({
      id: HOUSE_SAMPLE_PRODUCT_ID,
      slug: "impostor_with_house_id",
      book_registry: "books/duane.json",
      creator_is_house: false,
    });
    const hits = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(HOUSE_SAMPLE_PRODUCT_ID));
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("warns once for a house product with neither a book_registry nor a slug override", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const product = { id: "cccccccc-0000-4000-8000-000000000003", slug: "house_unregistered", book_registry: null, creator_is_house: true };
    resolveProductBookAssets(product);
    resolveProductBookAssets(product);
    const hits = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("cccccccc-0000-4000-8000-000000000003"));
    expect(hits).toHaveLength(1);
  });

  it("logs a non-boolean override is_sample instead of silently treating it as not sample", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const overrides = GLOBAL.storefront.book_assets as Record<string, { is_sample?: unknown }>;
    overrides.override_probe_slug = { is_sample: "true" };
    try {
      const resolved = resolveProductBookAssets({ slug: "override_probe_slug", book_registry: null, creator_is_house: true });
      expect(resolved.is_sample).toBe(false);
      expect(error.mock.calls.map((c) => String(c[0])).some((m) => m.includes("non-boolean override is_sample"))).toBe(true);
    } finally {
      delete overrides.override_probe_slug;
    }
  });

  it("warns for a house product whose registry file names another product id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveProductBookAssets({
      id: "dddddddd-0000-4000-8000-000000000004",
      slug: "house_wrong_identity",
      book_registry: "books/duane.json",
      creator_is_house: true,
    });
    const hits = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("dddddddd-0000-4000-8000-000000000004"));
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("warns for a house product whose books json resolves with no cover_image", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const overrides = GLOBAL.storefront.book_assets as Record<string, { book_registry?: string; cover_image?: string | null }>;
    overrides.house_no_cover_probe = { book_registry: "books/smoke.json", cover_image: null };
    try {
      const resolved = resolveProductBookAssets({
        id: "eeeeeeee-0000-4000-8000-000000000005",
        slug: "house_no_cover_probe",
        book_registry: null,
        creator_is_house: true,
      });
      expect(resolved.cover_image).toBeNull();
      const hits = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("house_no_cover_probe") || m.includes("eeeeeeee-0000-4000-8000-000000000005"));
      expect(hits.some((m) => m.includes("no cover_image"))).toBe(true);
    } finally {
      delete overrides.house_no_cover_probe;
    }
  });

  it("warns for a house product whose books json has no string product_id (identity unchecked)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveProductBookAssets({
      id: "ababab02-0000-4000-8000-000000000007",
      slug: "house_no_identity_field",
      book_registry: "books/smoke.json",
      creator_is_house: true,
    });
    const hits = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("identity unchecked") && m.includes("ababab02-0000-4000-8000-000000000007"));
    expect(hits).toHaveLength(1);
  });

  it("fails closed and warns when creator_is_house is not a boolean", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolved = resolveProductBookAssets({
      id: "ababab01-0000-4000-8000-000000000006",
      slug: "string_house_flag",
      book_registry: "books/duane.json",
      creator_is_house: "true" as unknown as boolean,
    });
    expect(resolved).toMatchObject({ cover_image: null, preview_pdf: null, is_sample: false });
    const hits = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("treated as non-house") && m.includes("ababab01-0000-4000-8000-000000000006"));
    expect(hits).toHaveLength(1);
  });
});
