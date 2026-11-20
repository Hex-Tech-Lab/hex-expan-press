// Voice ranking for Read Aloud. Every marker, gender hint and language comes from the registry,
// so these tests use DEFAULT_GLOBAL and the real order it declares.
import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL, type BookPreviewReadAloudVoiceSettings } from "../../payments/src/settings_registry";
import { rankVoice } from "../src/components/storefront/read-aloud-voice";

const voiceSettings: BookPreviewReadAloudVoiceSettings = DEFAULT_GLOBAL.book_preview.read_aloud.voice;

const v = (name: string, lang = "en-US") => ({ name, lang });

const ARIA = v("Microsoft Aria Online (Natural) - English (United States)");
const DAVID = v("Microsoft David - English (United States)");
const ZIRA = v("Microsoft Zira - English (United States)");
const GOOGLE_US = v("Google US English");
const SAMANTHA = v("Samantha");
const SAMANTHA_ENHANCED = v("Samantha (Enhanced)");

describe("rankVoice: quality, language and gender", () => {
  it("picks Microsoft Aria Online (Natural) over legacy Microsoft David", () => {
    expect(rankVoice([DAVID, ARIA], voiceSettings)).toBe(ARIA);
  });

  it("picks Google US English over legacy Microsoft David", () => {
    expect(rankVoice([DAVID, GOOGLE_US], voiceSettings)).toBe(GOOGLE_US);
  });

  it("picks Apple Samantha (Enhanced) over plain Samantha", () => {
    expect(rankVoice([SAMANTHA, SAMANTHA_ENHANCED], voiceSettings)).toBe(SAMANTHA_ENHANCED);
  });

  it("ranks the earlier marker in the registry list higher (Online (Natural) before Google)", () => {
    expect(rankVoice([GOOGLE_US, ARIA], voiceSettings)).toBe(ARIA);
  });

  it("prefers the exact book language (en-US) over another English variant with a better marker", () => {
    const googleGb = v("Google UK English Female", "en-GB");
    expect(rankVoice([googleGb, DAVID], voiceSettings)).toBe(DAVID);
  });

  it("uses an en-* voice when no exact en-US voice exists", () => {
    const googleGb = v("Google UK English Female", "en-GB");
    expect(rankVoice([googleGb], voiceSettings)).toBe(googleGb);
  });

  it("never returns a voice in another language, so the browser default is used", () => {
    expect(rankVoice([v("Google Deutsch", "de-DE"), v("Thomas", "fr-FR")], voiceSettings)).toBeNull();
  });

  it("returns null for an empty voice list (voices not loaded yet)", () => {
    expect(rankVoice([], voiceSettings)).toBeNull();
  });

  it("orders plain voices by the registry gender order (female first by default)", () => {
    expect(rankVoice([DAVID, ZIRA], voiceSettings)).toBe(ZIRA);
  });

  it("honours a configured gender order", () => {
    const maleFirst = { ...voiceSettings, gender_order: ["male", "female"] as const };
    expect(rankVoice([ZIRA, DAVID], maleFirst)).toBe(DAVID);
  });

  it("matches name tokens, so the hint Ava does not match Avatar (Avatar stays unknown gender)", () => {
    const avatar = v("Avatar Voice");
    // Substring matching would tag Avatar as female and beat David; token matching leaves it unknown.
    expect(rankVoice([avatar, DAVID], voiceSettings)).toBe(DAVID);
  });

  it("keeps the browser order when ranking keys tie", () => {
    const first = v("Unknown One");
    const second = v("Unknown Two");
    expect(rankVoice([first, second], voiceSettings)).toBe(first);
  });

  it("accepts underscore language tags from some platforms", () => {
    const underscored = v("Google US English", "en_US");
    expect(rankVoice([DAVID, underscored], voiceSettings)).toBe(underscored);
  });

  it("Edge desktop/Android: prefers Microsoft Online (Natural) voices over Google and legacy voices", () => {
    const edgeAva = v("Microsoft Ava Online (Natural) - English (United States)");
    const edgeGuy = v("Microsoft Guy Online (Natural) - English (United States)");
    expect(rankVoice([GOOGLE_US, DAVID, edgeGuy, edgeAva], voiceSettings)).toBe(edgeAva);
    // Same quality tier: the registry gender order (female first) decides.
    expect(rankVoice([edgeGuy, ARIA], voiceSettings)).toBe(ARIA);
  });
});
