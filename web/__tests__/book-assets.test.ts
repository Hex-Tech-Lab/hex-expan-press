import { describe, expect, it, vi } from "vitest";
import {
  isSafeCoverPath,
  isSafePreviewPdfPath,
  resolveProductBookAssets,
} from "../src/lib/book-assets";

/** books/sample_the_quiet_workshop.json identity: product_id is the house sample product's id. */
const HOUSE_SAMPLE_PRODUCT_ID = "9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc";
const UNRELATED_PRODUCT_ID = "00000000-0000-4000-8000-0000000000ff";

describe("book-assets path safety", () => {
  it("accepts valid /books/covers/* and https:// cover URLs and rejects traversal or non-image paths", () => {
    expect(isSafeCoverPath("/books/covers/duane.jpg")).toBe(true);
    expect(isSafeCoverPath("/books/covers/sample_the_quiet_workshop.webp")).toBe(true);
    expect(isSafeCoverPath("/books/covers/sample_the_quiet_workshop.png")).toBe(true);
    expect(isSafeCoverPath("https://cdn.example.com/covers/book.webp")).toBe(true);

    expect(isSafeCoverPath("/books/covers/../secret.png")).toBe(false);
    expect(isSafeCoverPath("/books/covers/not_an_image.pdf")).toBe(false);
    expect(isSafeCoverPath("http://insecure.example/cover.png")).toBe(false);
    expect(isSafeCoverPath("javascript:alert(1)")).toBe(false);
    expect(isSafeCoverPath(null)).toBe(false);
  });

  it("accepts valid /books/previews/*.pdf and https:// PDFs and rejects unsafe paths", () => {
    expect(isSafePreviewPdfPath("/books/previews/duane.pdf")).toBe(true);
    expect(isSafePreviewPdfPath("/books/previews/sample_the_quiet_workshop.pdf")).toBe(true);
    expect(isSafePreviewPdfPath("https://cdn.example.com/previews/book.pdf")).toBe(true);

    expect(isSafePreviewPdfPath("/books/previews/../paid.pdf")).toBe(false);
    expect(isSafePreviewPdfPath("/books/covers/duane.jpg")).toBe(false);
    expect(isSafePreviewPdfPath("http://insecure.example/preview.pdf")).toBe(false);
  });
});

describe("resolveProductBookAssets for house products (creator_is_house true)", () => {
  it("resolves cover_image, preview_pdf, and is_sample from products.book_registry -> books/*.json", () => {
    expect(
      resolveProductBookAssets({
        slug: "500k_playbook",
        title: "You Don't Need a Million Dollars to Retire",
        book_registry: "books/duane.json",
        creator_is_house: true,
      }),
    ).toEqual({
      book_registry: "books/duane.json",
      cover_image: "/books/covers/duane.jpg",
      preview_pdf: "/books/previews/duane.pdf",
      is_sample: false,
      overview: null,
    });

    const sampleAssets = resolveProductBookAssets({
      slug: "sample_the_quiet_workshop",
      title: "The Quiet Workshop (Sample)",
      book_registry: "books/sample_the_quiet_workshop.json",
      creator_is_house: true,
    });
    expect(sampleAssets).toMatchObject({
      book_registry: "books/sample_the_quiet_workshop.json",
      cover_image: "/books/covers/sample_the_quiet_workshop.webp",
      preview_pdf: "/books/previews/sample_the_quiet_workshop.pdf",
      is_sample: true,
    });
    expect(sampleAssets.overview).toContain("Setting Up the Bench");
    expect(sampleAssets.overview?.toLowerCase()).toContain("sample");
  });

  it("describes the house sample as a preview sample coming soon, never as a sold or standalone product", () => {
    const overview = resolveProductBookAssets({
      slug: "sample_the_quiet_workshop",
      title: "The Quiet Workshop (Sample)",
      book_registry: "books/sample_the_quiet_workshop.json",
      creator_is_house: true,
    }).overview;
    expect(overview).toMatch(/preview sample/i);
    expect(overview).toMatch(/coming soon/i);
    expect(overview).not.toMatch(/standalone/i);
    expect(overview).not.toMatch(/delivered by email/i);
    expect(overview).not.toMatch(/\bsold\b/i);
    expect(overview).not.toMatch(/\bguides?\b/i);
  });

  it("falls back to GLOBAL.storefront.book_assets[slug] when products.book_registry is null", () => {
    expect(
      resolveProductBookAssets({
        slug: "500k_playbook",
        title: "500k Playbook",
        book_registry: null,
        creator_is_house: true,
      }),
    ).toEqual({
      book_registry: "books/duane.json",
      cover_image: "/books/covers/duane.jpg",
      preview_pdf: "/books/previews/duane.pdf",
      is_sample: false,
      overview: null,
    });
  });

  it("rejects path-traversal book_registry values and falls back cleanly", () => {
    const resolved = resolveProductBookAssets({
      slug: "unknown_book",
      title: "Some Book",
      book_registry: "../../etc/passwd",
      creator_is_house: true,
    });
    expect(resolved).toEqual({
      book_registry: null,
      cover_image: null,
      preview_pdf: null,
      is_sample: false,
      overview: null,
    });
  });

  it("never infers is_sample from a sample_ slug or a (Sample) title; only an explicit is_sample in books/*.json counts", () => {
    expect(
      resolveProductBookAssets({
        slug: "sample_another_book",
        title: "Another Book",
        book_registry: null,
        creator_is_house: true,
      }).is_sample,
    ).toBe(false);
    expect(
      resolveProductBookAssets({
        slug: "sample_duane",
        title: "Duane Playbook (Sample)",
        book_registry: "books/duane.json",
        creator_is_house: true,
      }).is_sample,
    ).toBe(false);
  });
});

describe("resolveProductBookAssets never lets a non-house product claim house assets", () => {
  it("gives a non-house product with the house sample slug and (Sample) title no cover, no preview, and is_sample false", () => {
    expect(
      resolveProductBookAssets({
        id: UNRELATED_PRODUCT_ID,
        slug: "sample_the_quiet_workshop",
        title: "The Quiet Workshop (Sample)",
        book_registry: "books/sample_the_quiet_workshop.json",
        creator_is_house: false,
      }),
    ).toEqual({
      book_registry: null,
      cover_image: null,
      preview_pdf: null,
      is_sample: false,
      overview: null,
    });
  });

  it("gives a non-house product with the registry slug and no books/*.json identity nothing from the house registry", () => {
    expect(
      resolveProductBookAssets({
        id: UNRELATED_PRODUCT_ID,
        slug: "500k_playbook",
        title: "500k Playbook",
        book_registry: null,
        creator_is_house: false,
      }),
    ).toEqual({
      book_registry: null,
      cover_image: null,
      preview_pdf: null,
      is_sample: false,
      overview: null,
    });
  });

  it("logs and fails closed when a house registry path has no books/*.json file", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const resolved = resolveProductBookAssets({
        slug: "unbundled_house_book",
        book_registry: "books/no_such_book_for_test.json",
        creator_is_house: true,
      });
      expect(resolved).toMatchObject({ cover_image: null, preview_pdf: null, is_sample: false, overview: null });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("books json missing for books/no_such_book_for_test.json"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("resolves Duane's live product through the exact product_id in books/duane.json, with no house flag", () => {
    expect(
      resolveProductBookAssets({
        id: "57596c19-c550-4bde-b17a-e87b86d005c5",
        slug: "retirearly500k",
        title: "You Don't Need a Million Dollars to Retire",
        book_registry: "books/duane.json",
        creator_is_house: false,
      }),
    ).toMatchObject({
      book_registry: "books/duane.json",
      cover_image: "/books/covers/duane.jpg",
      preview_pdf: "/books/previews/duane.pdf",
      is_sample: false,
    });
  });

  it("gives a non-house product whose slug matches a registry key no override when its id does not match", () => {
    expect(
      resolveProductBookAssets({
        id: UNRELATED_PRODUCT_ID,
        slug: "500k_playbook",
        title: "500k Playbook",
        book_registry: "books/duane.json",
        creator_is_house: false,
      }),
    ).toEqual({
      book_registry: null,
      cover_image: null,
      preview_pdf: null,
      is_sample: false,
      overview: null,
    });
  });

  it("honours a non-house product only when its id is the books/*.json product_id (exact identity match)", () => {
    const resolved = resolveProductBookAssets({
      id: HOUSE_SAMPLE_PRODUCT_ID,
      slug: "any_slug",
      title: "Any Title",
      book_registry: "books/sample_the_quiet_workshop.json",
      creator_is_house: false,
    });
    expect(resolved).toMatchObject({
      book_registry: "books/sample_the_quiet_workshop.json",
      cover_image: "/books/covers/sample_the_quiet_workshop.webp",
      preview_pdf: "/books/previews/sample_the_quiet_workshop.pdf",
      is_sample: true,
    });
  });
});
