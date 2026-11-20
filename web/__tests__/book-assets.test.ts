import { describe, expect, it } from "vitest";
import {
  isSafeCoverPath,
  isSafePreviewPdfPath,
  isSampleTitle,
  resolveProductBookAssets,
} from "../src/lib/book-assets";

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

describe("resolveProductBookAssets", () => {
  it("resolves cover_image, preview_pdf, and is_sample from products.book_registry -> books/*.json", () => {
    expect(
      resolveProductBookAssets({
        slug: "500k_playbook",
        title: "You Don't Need a Million Dollars to Retire",
        book_registry: "books/duane.json",
      }),
    ).toEqual({
      book_registry: "books/duane.json",
      cover_image: "/books/covers/duane.jpg",
      preview_pdf: "/books/previews/duane.pdf",
      is_sample: false,
    });

    expect(
      resolveProductBookAssets({
        slug: "sample_the_quiet_workshop",
        title: "The Quiet Workshop (Sample)",
        book_registry: "books/sample_the_quiet_workshop.json",
      }),
    ).toEqual({
      book_registry: "books/sample_the_quiet_workshop.json",
      cover_image: "/books/covers/sample_the_quiet_workshop.webp",
      preview_pdf: "/books/previews/sample_the_quiet_workshop.pdf",
      is_sample: true,
    });
  });

  it("falls back to GLOBAL.storefront.book_assets[slug] when products.book_registry is null", () => {
    expect(
      resolveProductBookAssets({
        slug: "500k_playbook",
        title: "500k Playbook",
        book_registry: null,
      }),
    ).toEqual({
      book_registry: "books/duane.json",
      cover_image: "/books/covers/duane.jpg",
      preview_pdf: "/books/previews/duane.pdf",
      is_sample: false,
    });
  });

  it("rejects path-traversal book_registry values and falls back cleanly", () => {
    const resolved = resolveProductBookAssets({
      slug: "unknown_book",
      title: "Some Book",
      book_registry: "../../etc/passwd",
    });
    expect(resolved).toEqual({
      book_registry: null,
      cover_image: null,
      preview_pdf: null,
      is_sample: false,
    });
  });

  it("detects sample products from title or sample_ slug prefix even without a book JSON", () => {
    expect(isSampleTitle("The Quiet Workshop (Sample)")).toBe(true);
    expect(isSampleTitle("Full Book")).toBe(false);
    expect(
      resolveProductBookAssets({
        slug: "sample_another_book",
        title: "Another Book",
        book_registry: null,
      }).is_sample,
    ).toBe(true);
  });
});
