import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBookIdentity } from "../book_identity";
import {
  DEFAULT_GLOBAL,
  loadBookPreviewSection,
  loadStorefrontSection,
} from "../src/settings_registry";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("loadStorefrontSection (settings_registry)", () => {
  it("returns defaults when section is omitted", () => {
    expect(loadStorefrontSection(undefined)).toEqual(DEFAULT_GLOBAL.storefront);
  });

  it("accepts valid overrides for card labels, safe /books/* base paths, and slug asset map", () => {
    const out = loadStorefrontSection({
      b2c_landing_url: "https://staging.expanpress.com/books",
      digital_pdf_kicker: "E-BOOK PDF",
      brand_name: "ExpanPress Books",
      publisher_label: "Ignored: publisher_label is derived from brand_name",
      sample_badge_label: "(Preview)",
      covers_base_path: "/books/cover_art",
      previews_base_path: "/books/preview_pdfs",
      book_assets: {
        custom_slug: {
          book_registry: "books/duane.json",
          cover_image: "/books/cover_art/custom.png",
          preview_pdf: "/books/preview_pdfs/custom.pdf",
          is_sample: true,
        },
      },
    });
    expect(out.b2c_landing_url).toBe("https://staging.expanpress.com/books");
    expect(out.digital_pdf_kicker).toBe("E-BOOK PDF");
    expect(out.brand_name).toBe("ExpanPress Books");
    expect(out.publisher_label).toBe("ExpanPress Books");
    expect(out.sample_badge_label).toBe("(Preview)");
    expect(out.covers_base_path).toBe("/books/cover_art");
    expect(out.previews_base_path).toBe("/books/preview_pdfs");
    expect(out.book_assets.custom_slug).toEqual({
      book_registry: "books/duane.json",
      cover_image: "/books/cover_art/custom.png",
      preview_pdf: "/books/preview_pdfs/custom.pdf",
      is_sample: true,
    });
  });

  it("falls back to defaults for unsafe paths, non-https landing url, or blank labels", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = loadStorefrontSection({
      b2c_landing_url: "http://expanpress.com/books",
      digital_pdf_kicker: "   ",
      covers_base_path: "/etc/passwd",
      previews_base_path: "/books/../secret",
      book_assets: { "bad-slug": { cover_image: "/x" } },
    });
    expect(out.b2c_landing_url).toBe(DEFAULT_GLOBAL.storefront.b2c_landing_url);
    expect(out.digital_pdf_kicker).toBe(DEFAULT_GLOBAL.storefront.digital_pdf_kicker);
    expect(out.covers_base_path).toBe(DEFAULT_GLOBAL.storefront.covers_base_path);
    expect(out.previews_base_path).toBe(DEFAULT_GLOBAL.storefront.previews_base_path);
    expect(out.book_assets["bad-slug"]).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("loadBookPreviewSection (settings_registry)", () => {
  it("returns defaults when section is omitted", () => {
    expect(loadBookPreviewSection(undefined)).toEqual(DEFAULT_GLOBAL.book_preview);
  });

  it("applies valid overrides within bounds", () => {
    const out = loadBookPreviewSection({
      render_scale: 1.5,
      max_preview_pages: 10,
      page_width_px: 360,
      page_height_px: 540,
      flipping_time_ms: 450,
      max_shadow_opacity: 0.35,
      show_cover: false,
      use_portrait: true,
      heading: "Look inside",
    });
    expect(out.render_scale).toBe(1.5);
    expect(out.max_preview_pages).toBe(10);
    expect(out.page_width_px).toBe(360);
    expect(out.page_height_px).toBe(540);
    expect(out.flipping_time_ms).toBe(450);
    expect(out.max_shadow_opacity).toBe(0.35);
    expect(out.show_cover).toBe(false);
    expect(out.heading).toBe("Look inside");
  });

  it("falls back for out-of-range numbers and traversal worker paths", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = loadBookPreviewSection({
      render_scale: 10,
      max_preview_pages: 1,
      flipping_time_ms: 10,
      max_shadow_opacity: 2,
      pdf_worker_src: "/pdfjs/../evil.mjs",
      show_cover: "yes",
    });
    expect(out.render_scale).toBe(DEFAULT_GLOBAL.book_preview.render_scale);
    expect(out.max_preview_pages).toBe(DEFAULT_GLOBAL.book_preview.max_preview_pages);
    expect(out.flipping_time_ms).toBe(DEFAULT_GLOBAL.book_preview.flipping_time_ms);
    expect(out.max_shadow_opacity).toBe(DEFAULT_GLOBAL.book_preview.max_shadow_opacity);
    expect(out.pdf_worker_src).toBe(DEFAULT_GLOBAL.book_preview.pdf_worker_src);
    expect(out.show_cover).toBe(DEFAULT_GLOBAL.book_preview.show_cover);
    warn.mockRestore();
  });
});

describe("loadBookIdentity optional media fields", () => {
  it("loads cover_image, preview_pdf, and is_sample from books/duane.json and books/sample_the_quiet_workshop.json", () => {
    const duane = loadBookIdentity("books/duane.json");
    expect(duane.cover_image).toBe("/books/covers/duane.jpg");
    expect(duane.preview_pdf).toBe("/books/previews/duane.pdf");
    expect(duane.is_sample).toBe(false);

    const sample = loadBookIdentity("books/sample_the_quiet_workshop.json");
    expect(sample.cover_image).toBe("/books/covers/sample_the_quiet_workshop.webp");
    expect(sample.preview_pdf).toBe("/books/previews/sample_the_quiet_workshop.pdf");
    expect(sample.is_sample).toBe(true);
  });

  it("omits optional keys when not present in a book JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "book-id-media-"));
    tmpDirs.push(dir);
    const p = join(dir, "minimal.json");
    writeFileSync(p, JSON.stringify({ id: "m", title: "T", subtitle: "S", author: "A" }), "utf8");
    expect(loadBookIdentity(p)).toEqual({ id: "m", title: "T", subtitle: "S", author: "A" });
  });
});
