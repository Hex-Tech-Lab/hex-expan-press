import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL, loadBookPreviewSection } from "../src/settings_registry";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("read_aloud voice and highlight_words (settings_registry)", () => {
  it("defaults: en-US language, quality markers in priority order, female first, word highlight off", () => {
    const ra = DEFAULT_GLOBAL.book_preview.read_aloud;
    expect(ra.highlight_words).toBe(false);
    expect(ra.voice.lang).toBe("en-US");
    expect(ra.voice.quality_markers.slice(0, 3)).toEqual(["Online (Natural)", "Natural", "Google"]);
    expect(ra.voice.gender_order).toEqual(["female", "male"]);
  });

  it("accepts a valid override of voice fields and highlight_words", () => {
    const out = loadBookPreviewSection({
      read_aloud: {
        highlight_words: true,
        voice: {
          lang: "en-GB",
          quality_markers: ["Neural"],
          gender_order: ["male"],
          female_name_hints: ["Hazel"],
          male_name_hints: ["George"],
        },
      },
    });
    expect(out.read_aloud.highlight_words).toBe(true);
    expect(out.read_aloud.voice).toEqual({
      lang: "en-GB",
      quality_markers: ["Neural"],
      gender_order: ["male"],
      female_name_hints: ["Hazel"],
      male_name_hints: ["George"],
    });
  });

  it("keeps the default for each invalid voice field and reports it as a fallback", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = loadBookPreviewSection({
      read_aloud: {
        highlight_words: "yes",
        voice: {
          lang: "english",
          gender_order: ["female", "female"],
          quality_markers: [""],
          female_name_hints: "Aria",
          male_name_hints: ["David"],
        },
      },
    });
    const defaults = DEFAULT_GLOBAL.book_preview.read_aloud.voice;
    expect(out.read_aloud.highlight_words).toBe(false);
    expect(out.read_aloud.voice.lang).toBe(defaults.lang);
    expect(out.read_aloud.voice.gender_order).toEqual(defaults.gender_order);
    expect(out.read_aloud.voice.quality_markers).toEqual(defaults.quality_markers);
    expect(out.read_aloud.voice.female_name_hints).toEqual(defaults.female_name_hints);
    expect(out.read_aloud.voice.male_name_hints).toEqual(["David"]);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back to the whole default voice block when voice is not an object", () => {
    const out = loadBookPreviewSection({ read_aloud: { voice: "Aria" } });
    expect(out.read_aloud.voice).toEqual(DEFAULT_GLOBAL.book_preview.read_aloud.voice);
  });
});
