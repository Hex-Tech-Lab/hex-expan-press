import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBookIdentity } from "../book_identity";
import {
  DEFAULT_GLOBAL,
  loadBookPreviewSection,
  loadEndpointsSection,
  loadStorefrontSection,
  loadVoiceNarrationSection,
  VOICE_CREATOR_ALLOWED_ORIGINS,
} from "../src/settings_registry";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("storefront.browse_books_enabled (storefront flag)", () => {
  it("defaults to false so the home browse-books links stay hidden", () => {
    expect(DEFAULT_GLOBAL.storefront.browse_books_enabled).toBe(false);
    expect(loadStorefrontSection(undefined).browse_books_enabled).toBe(false);
  });

  it("accepts an explicit boolean", () => {
    expect(loadStorefrontSection({ browse_books_enabled: true }).browse_books_enabled).toBe(true);
    expect(loadStorefrontSection({ browse_books_enabled: false }).browse_books_enabled).toBe(false);
  });

  it("falls back to false on a non-boolean value", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadStorefrontSection({ browse_books_enabled: "true" }).browse_books_enabled).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("loadStorefrontSection (settings_registry)", () => {
  it("returns defaults when section is omitted (including non-live sample launch flags and LV-02/03/05 keys)", () => {
    const out = loadStorefrontSection(undefined);
    expect(out).toEqual(DEFAULT_GLOBAL.storefront);
    expect(out.show_non_live_samples).toBe(true);
    expect(out.allowed_non_live_sample_modes).toEqual(["gated"]);
    expect(out.coming_soon_badge).toBe("Coming soon");
    expect(out.sample_preview_cta).toBe("Preview sample");
    expect(out.browse_books_label).toBe("Browse books");
    expect(out.browse_books_path).toBe("/books");
    expect(out.always_show_buyer_legal).toBe(true);
    expect(out.pay_root_kicker).toBe("Secure checkout");
    expect(out.pay_root_heading).toBe("Digital book checkout");
    expect(out.pay_root_description.length).toBeGreaterThan(0);
    expect(out.buyer_legal_links.map((l) => l.label)).toEqual(["Privacy Policy", "Terms of Sale", "Refund Policy"]);
    expect(out.buyer_legal_links.map((l) => l.path)).toEqual([
      "/books/legal/privacy.html",
      "/books/legal/terms.html",
      "/books/legal/refund-policy.html",
    ]);
  });

  it("accepts valid overrides for card labels, sample listing toggles, safe /books/* base paths, and slug asset map", () => {
    const out = loadStorefrontSection({
      b2c_landing_url: "https://staging.expanpress.com/books",
      digital_pdf_kicker: "E-BOOK PDF",
      brand_name: "ExpanPress Books",
      publisher_label: "Ignored: publisher_label is derived from brand_name",
      sample_badge_label: "(Preview)",
      show_non_live_samples: false,
      allowed_non_live_sample_modes: ["gated", "sandbox"],
      coming_soon_badge: "Launching soon",
      sample_preview_cta: "Read Chapter 1",
      browse_books_label: "Explore catalog",
      browse_books_path: "/books/catalog",
      always_show_buyer_legal: false,
      pay_root_heading: "Pay ExpanPress",
      pay_root_description: "Secure hosted checkout.",
      covers_base_path: "/books/cover_art",
      previews_base_path: "/books/preview_pdfs",
      audio_base_path: "/books/audio_tracks",
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
    expect(out.show_non_live_samples).toBe(false);
    expect(out.allowed_non_live_sample_modes).toEqual(["gated", "sandbox"]);
    expect(out.coming_soon_badge).toBe("Launching soon");
    expect(out.sample_preview_cta).toBe("Read Chapter 1");
    expect(out.browse_books_label).toBe("Explore catalog");
    expect(out.browse_books_path).toBe("/books/catalog");
    expect(out.always_show_buyer_legal).toBe(false);
    expect(out.pay_root_heading).toBe("Pay ExpanPress");
    expect(out.pay_root_description).toBe("Secure hosted checkout.");
    expect(out.covers_base_path).toBe("/books/cover_art");
    expect(out.previews_base_path).toBe("/books/preview_pdfs");
    expect(out.audio_base_path).toBe("/books/audio_tracks");
    expect(out.book_assets.custom_slug).toEqual({
      book_registry: "books/duane.json",
      cover_image: "/books/cover_art/custom.png",
      preview_pdf: "/books/preview_pdfs/custom.pdf",
      is_sample: true,
    });
  });

  it("falls back to defaults for unsafe paths, non-https landing url, invalid sample modes, or blank labels", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = loadStorefrontSection({
      b2c_landing_url: "http://expanpress.com/books",
      digital_pdf_kicker: "   ",
      show_non_live_samples: "yes",
      allowed_non_live_sample_modes: ["live"],
      coming_soon_badge: "",
      sample_preview_cta: "   ",
      browse_books_label: "   ",
      browse_books_path: "/creator",
      always_show_buyer_legal: "true",
      pay_root_heading: "",
      pay_root_description: "   ",
      covers_base_path: "/etc/passwd",
      previews_base_path: "/books/../secret",
      book_assets: { "bad-slug": { cover_image: "/x" } },
    });
    expect(out.b2c_landing_url).toBe(DEFAULT_GLOBAL.storefront.b2c_landing_url);
    expect(out.digital_pdf_kicker).toBe(DEFAULT_GLOBAL.storefront.digital_pdf_kicker);
    expect(out.show_non_live_samples).toBe(DEFAULT_GLOBAL.storefront.show_non_live_samples);
    expect(out.allowed_non_live_sample_modes).toEqual(DEFAULT_GLOBAL.storefront.allowed_non_live_sample_modes);
    expect(out.coming_soon_badge).toBe(DEFAULT_GLOBAL.storefront.coming_soon_badge);
    expect(out.sample_preview_cta).toBe(DEFAULT_GLOBAL.storefront.sample_preview_cta);
    expect(out.browse_books_label).toBe(DEFAULT_GLOBAL.storefront.browse_books_label);
    expect(out.browse_books_path).toBe(DEFAULT_GLOBAL.storefront.browse_books_path);
    expect(out.always_show_buyer_legal).toBe(DEFAULT_GLOBAL.storefront.always_show_buyer_legal);
    expect(out.pay_root_heading).toBe(DEFAULT_GLOBAL.storefront.pay_root_heading);
    expect(out.pay_root_description).toBe(DEFAULT_GLOBAL.storefront.pay_root_description);
    expect(out.covers_base_path).toBe(DEFAULT_GLOBAL.storefront.covers_base_path);
    expect(out.previews_base_path).toBe(DEFAULT_GLOBAL.storefront.previews_base_path);
    expect(out.book_assets["bad-slug"]).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("validates storefront.product_layout overrides and falls back when out of range or malformed", () => {
    const valid = loadStorefrontSection({
      product_layout: {
        cover_max_width_px: 360,
        cover_max_width_pct: 34,
        gap_mobile_px: 20,
        gap_desktop_px: 48,
        preview_section_id: "sample-preview",
        preview_cue_label: "Peek inside",
        cue_bounce_distance_px: 6,
        cue_bounce_duration_s: 1.5,
        cue_bounce_repeat_delay_s: 0.25,
      },
    });
    expect(valid.product_layout).toEqual({
      cover_max_width_px: 360,
      cover_max_width_pct: 34,
      gap_mobile_px: 20,
      gap_desktop_px: 48,
      preview_section_id: "sample-preview",
      preview_cue_label: "Peek inside",
      cue_bounce_distance_px: 6,
      cue_bounce_duration_s: 1.5,
      cue_bounce_repeat_delay_s: 0.25,
    });

    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const invalid = loadStorefrontSection({
      product_layout: {
        cover_max_width_px: 9999,
        cover_max_width_pct: 90,
        gap_mobile_px: 2,
        gap_desktop_px: 200,
        preview_section_id: "Bad Id!",
        preview_cue_label: "   ",
        cue_bounce_distance_px: 0,
        cue_bounce_duration_s: 20,
        cue_bounce_repeat_delay_s: -1,
      },
    });
    expect(invalid.product_layout).toEqual(DEFAULT_GLOBAL.storefront.product_layout);
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
      resize_min_delta_px: 4,
      show_cover: false,
      use_portrait: true,
      heading: "Look inside",
      zoom_levels: [1, 1.5, 2],
      toolbar_labels: {
        toolbar_aria_label: "Reader tools",
        zoom_in: "Larger",
        zoom_out: "Smaller",
        reset_zoom: "Actual size",
        go_to_page: "Jump to page",
        go_to_page_submit: "Jump",
      },
      read_aloud: {
        enabled: true,
        rates: [0.75, 1, 1.5],
        default_rate: 1.5,
        max_chunk_chars: 140,
        labels: {
          play: "Listen to sample",
          stop: "Stop audio",
        },
      },
      text_structure: {
        line_y_tolerance: 3,
        heading_scale_ratio: 1.25,
        major_heading_scale_ratio: 1.5,
        paragraph_gap_ratio: 1.8,
        max_heading_chars: 100,
        toggle_single: "Show page text",
        toggle_plural: "Show spread text",
        page_label_prefix: "Sheet",
      },
    });
    expect(out.render_scale).toBe(1.5);
    expect(out.max_preview_pages).toBe(10);
    expect(out.page_width_px).toBe(360);
    expect(out.page_height_px).toBe(540);
    expect(out.flipping_time_ms).toBe(450);
    expect(out.max_shadow_opacity).toBe(0.35);
    expect(out.resize_min_delta_px).toBe(4);
    expect(out.show_cover).toBe(false);
    expect(out.heading).toBe("Look inside");
    expect(out.zoom_levels).toEqual([1, 1.5, 2]);
    expect(out.toolbar_labels.zoom_in).toBe("Larger");
    expect(out.read_aloud.rates).toEqual([0.75, 1, 1.5]);
    expect(out.read_aloud.default_rate).toBe(1.5);
    expect(out.read_aloud.max_chunk_chars).toBe(140);
    expect(out.read_aloud.labels.play).toBe("Listen to sample");
    expect(out.read_aloud.labels.stop).toBe("Stop audio");
    expect(out.text_structure.line_y_tolerance).toBe(3);
    expect(out.text_structure.major_heading_scale_ratio).toBe(1.5);
    expect(out.text_structure.toggle_plural).toBe("Show spread text");
  });

  it("falls back for out-of-range numbers, invalid zoom_levels/toolbar_labels/read_aloud/text_structure, and traversal worker paths", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = loadBookPreviewSection({
      render_scale: 10,
      max_preview_pages: 1,
      flipping_time_ms: 10,
      max_shadow_opacity: 2,
      resize_min_delta_px: 51,
      pdf_worker_src: "/pdfjs/../evil.mjs",
      show_cover: "yes",
      zoom_levels: [1, 1],
      toolbar_labels: { zoom_in: "  " },
      read_aloud: {
        enabled: "yes",
        rates: [1.5, 1],
        default_rate: 9,
        max_chunk_chars: 10,
        labels: { play: "   " },
      },
      text_structure: {
        line_y_tolerance: 0,
        heading_scale_ratio: 0.9,
        major_heading_scale_ratio: 1.0,
        paragraph_gap_ratio: 99,
        max_heading_chars: 5,
        toggle_single: "",
      },
    });
    expect(out.render_scale).toBe(DEFAULT_GLOBAL.book_preview.render_scale);
    expect(out.resize_min_delta_px).toBe(1);
    expect(out.max_preview_pages).toBe(DEFAULT_GLOBAL.book_preview.max_preview_pages);
    expect(out.flipping_time_ms).toBe(DEFAULT_GLOBAL.book_preview.flipping_time_ms);
    expect(out.max_shadow_opacity).toBe(DEFAULT_GLOBAL.book_preview.max_shadow_opacity);
    expect(out.pdf_worker_src).toBe(DEFAULT_GLOBAL.book_preview.pdf_worker_src);
    expect(out.show_cover).toBe(DEFAULT_GLOBAL.book_preview.show_cover);
    expect(out.zoom_levels).toEqual(DEFAULT_GLOBAL.book_preview.zoom_levels);
    expect(out.toolbar_labels).toEqual(DEFAULT_GLOBAL.book_preview.toolbar_labels);
    expect(out.read_aloud).toEqual(DEFAULT_GLOBAL.book_preview.read_aloud);
    expect(out.text_structure).toEqual(DEFAULT_GLOBAL.book_preview.text_structure);

    const crossField = loadBookPreviewSection({
      text_structure: { heading_scale_ratio: 1.4, major_heading_scale_ratio: 1.2 },
    });
    expect(crossField.text_structure.heading_scale_ratio).toBe(1.4);
    expect(crossField.text_structure.major_heading_scale_ratio).toBe(1.45);
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
    expect(sample.preview_audio_manifest).toBe("/books/audio/sample_the_quiet_workshop/timings.json");
    expect(sample.is_sample).toBe(true);
    expect(sample.overview).toBeDefined();
    expect(sample.overview).toContain("Setting Up the Bench");
    expect(sample.overview?.toLowerCase()).toContain("sample");
  });

  it("validates text_structure folio settings and voice_narration defaults/bounds", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const valid = loadBookPreviewSection({
      text_structure: {
        strip_margin_folios: false,
        bottom_margin_ratio: 0.12,
        fallback_page_height_pt: 792,
        folio_max_scale_ratio: 1.8,
        folio_max_digits: 3,
        allow_roman_folios: false,
        folio_roman_max_length: 5,
      },
    });
    expect(valid.text_structure.strip_margin_folios).toBe(false);
    expect(valid.text_structure.bottom_margin_ratio).toBe(0.12);
    expect(valid.text_structure.fallback_page_height_pt).toBe(792);
    expect(valid.text_structure.folio_max_scale_ratio).toBe(1.8);
    expect(valid.text_structure.folio_max_digits).toBe(3);
    expect(valid.text_structure.allow_roman_folios).toBe(false);
    expect(valid.text_structure.folio_roman_max_length).toBe(5);

    const invalid = loadBookPreviewSection({
      text_structure: {
        strip_margin_folios: "no",
        bottom_margin_ratio: 0.9,
        fallback_page_height_pt: 10,
        folio_max_scale_ratio: 99,
        folio_max_digits: 99,
        allow_roman_folios: "yes",
        folio_roman_max_length: 0,
      },
    });
    expect(invalid.text_structure).toEqual(DEFAULT_GLOBAL.book_preview.text_structure);

    expect(DEFAULT_GLOBAL.voice_narration.default_voice_id).toBe("c9f39b88-235b-4c2a-851c-3734ce1203be");
    expect(DEFAULT_GLOBAL.voice_narration.fallback_female_voice_id).toBe("84394fa8-60a1-40d9-9a4e-f86738f6b12c");
    expect(DEFAULT_GLOBAL.voice_narration.opus_codec).toBe("libopus");
    expect(DEFAULT_GLOBAL.voice_narration.opus_bitrate_kbps).toBe(32);
    expect(DEFAULT_GLOBAL.voice_narration.opus_vbr).toBe("on");
    expect(DEFAULT_GLOBAL.voice_narration.tempo).toBe(1.16);
    expect(DEFAULT_GLOBAL.voice_narration.sentence_gap_ms).toBe(220);
    expect(DEFAULT_GLOBAL.voice_narration.paragraph_gap_ms).toBe(680);
    expect(DEFAULT_GLOBAL.voice_narration.section_gap_ms).toBe(1200);
    expect(DEFAULT_GLOBAL.voice_narration.silence_threshold_db).toBe(-54);
    expect(DEFAULT_GLOBAL.voice_narration.silence_pad_start_ms).toBe(70);
    expect(DEFAULT_GLOBAL.voice_narration.silence_pad_end_ms).toBe(90);
    expect(DEFAULT_GLOBAL.voice_narration.silence_fade_ms).toBe(18);
    expect(DEFAULT_GLOBAL.voice_narration.lexicon).toEqual([
      { pattern: "ExpanPress", flags: "gi", replacement: "Expan Press" },
      { pattern: "Elias", flags: "gi", replacement: "Eliyas" },
    ]);
    expect(loadVoiceNarrationSection(undefined)).toEqual(DEFAULT_GLOBAL.voice_narration);
    const vnCustom = loadVoiceNarrationSection({
      opus_bitrate_kbps: 48,
      opus_vbr: "constrained",
      tempo: 1.1,
      section_gap_ms: 1500,
      silence_fade_ms: 20,
      master_filter: "",
      lexicon: [],
    });
    expect(vnCustom.opus_bitrate_kbps).toBe(48);
    expect(vnCustom.opus_vbr).toBe("constrained");
    expect(vnCustom.tempo).toBe(1.1);
    expect(vnCustom.section_gap_ms).toBe(1500);
    expect(vnCustom.silence_fade_ms).toBe(20);
    expect(vnCustom.master_filter).toBe("");
    expect(vnCustom.lexicon).toEqual([]);
    warn.mockClear();
    const vnInvalid = loadVoiceNarrationSection({
      loudnorm_lufs: 5,
      mp3_bitrate_kbps: 9999,
      opus_bitrate_kbps: 500,
      opus_vbr: "invalid",
      tempo: 2.5,
      section_gap_ms: -50,
      silence_fade_ms: 250,
      master_filter: "highpass=f=80\nrm -rf /",
      lexicon: [{ pattern: "", replacement: "bad" }],
    });
    expect(vnInvalid).toEqual(DEFAULT_GLOBAL.voice_narration);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    expect(loadVoiceNarrationSection({ lexicon: [{ pattern: "a", flags: "z", replacement: "b" }] }).lexicon).toEqual(
      DEFAULT_GLOBAL.voice_narration.lexicon,
    );
    expect(warn).toHaveBeenCalledTimes(1);

    for (const badSection of ["invalid", 42, true, [], null]) {
      warn.mockClear();
      expect(loadVoiceNarrationSection(badSection)).toEqual(DEFAULT_GLOBAL.voice_narration);
      expect(warn).toHaveBeenCalledTimes(1);
    }

    expect(VOICE_CREATOR_ALLOWED_ORIGINS).toContain("https://api.vcp.name");
    expect(loadEndpointsSection({ voicecreator_api: "https://api.vcp.name/" }).voicecreator_api).toBe(
      "https://api.vcp.name",
    );
    for (const unapproved of [
      "https://evil.example.com",
      "http://api.vcp.name",
      "https://user:pass@api.vcp.name",
      "https://api.vcp.name/v1?x=1",
    ]) {
      warn.mockClear();
      expect(loadEndpointsSection({ voicecreator_api: unapproved }).voicecreator_api).toBe(
        DEFAULT_GLOBAL.endpoints.voicecreator_api,
      );
      expect(warn).toHaveBeenCalledTimes(1);
    }
    warn.mockRestore();
  });

  it("omits optional keys when not present in a book JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "book-id-media-"));
    tmpDirs.push(dir);
    const p = join(dir, "minimal.json");
    writeFileSync(p, JSON.stringify({ id: "m", title: "T", subtitle: "S", author: "A" }), "utf8");
    expect(loadBookIdentity(p)).toEqual({ id: "m", title: "T", subtitle: "S", author: "A" });
  });
});
