// Basic-voice guidance for iPhone, iPad and Safari on macOS. Every marker, token and copy string comes from
// the registry, so these tests use DEFAULT_GLOBAL and the values it declares.
import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL, type BookPreviewReadAloudSettings } from "../../payments/src/settings_registry";
import {
  detectVoiceGuidePlatform,
  hasPremiumVoiceForLang,
  isIosDevice,
  isMacSafariDevice,
  shouldShowBasicVoiceGuide,
  stepsForPlatform,
  type DeviceSignals,
} from "../src/components/storefront/basic-voice-guide";

const readAloud: BookPreviewReadAloudSettings = DEFAULT_GLOBAL.book_preview.read_aloud;
const guide = readAloud.voice_guide;
const voiceSettings = readAloud.voice;

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const MAC_SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const MAC_CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MAC_FIREFOX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const IPHONE: DeviceSignals = { userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 };
const IPAD: DeviceSignals = { userAgent: IPAD_UA, platform: "iPad", maxTouchPoints: 5 };
// iPadOS in desktop-site mode: Macintosh UA and MacIntel, but touch is present.
const IPADOS_DESKTOP_MODE: DeviceSignals = { userAgent: MAC_SAFARI_UA, platform: "MacIntel", maxTouchPoints: 5 };
const MAC_SAFARI: DeviceSignals = { userAgent: MAC_SAFARI_UA, platform: "MacIntel", maxTouchPoints: 0 };
const MAC_CHROME: DeviceSignals = { userAgent: MAC_CHROME_UA, platform: "MacIntel", maxTouchPoints: 0 };
const MAC_FIREFOX: DeviceSignals = { userAgent: MAC_FIREFOX_UA, platform: "MacIntel", maxTouchPoints: 0 };
const ANDROID: DeviceSignals = { userAgent: ANDROID_UA, platform: "Linux armv8l", maxTouchPoints: 5 };
const WINDOWS: DeviceSignals = { userAgent: WINDOWS_UA, platform: "Win32", maxTouchPoints: 0 };

const v = (name: string, lang = "en-US") => ({ name, lang });

const BASIC_ONLY = [v("Samantha"), v("Microsoft David - English (United States)"), v("Google US English")];
const WITH_ENHANCED = [v("Samantha"), v("Ava (Enhanced)")];
const WITH_PREMIUM = [v("Zoe (Premium)")];
const ENHANCED_ONLY_NON_ENGLISH = [v("Anna (Enhanced)", "de-DE")];

describe("isIosDevice", () => {
  it("detects an iPhone by its user agent", () => {
    expect(isIosDevice(IPHONE, guide)).toBe(true);
  });

  it("detects an iPad by its user agent", () => {
    expect(isIosDevice(IPAD, guide)).toBe(true);
  });

  it("detects iPadOS in desktop-site mode (Macintosh UA with touch points)", () => {
    expect(isIosDevice(IPADOS_DESKTOP_MODE, guide)).toBe(true);
  });

  it("does not treat a real Mac (no touch points) as iOS", () => {
    expect(isIosDevice(MAC_SAFARI, guide)).toBe(false);
  });

  it("does not treat Android or Windows as iOS", () => {
    expect(isIosDevice(ANDROID, guide)).toBe(false);
    expect(isIosDevice(WINDOWS, guide)).toBe(false);
  });
});

describe("isMacSafariDevice", () => {
  it("detects Safari on macOS (Macintosh, Safari, no touch)", () => {
    expect(isMacSafariDevice(MAC_SAFARI, guide)).toBe(true);
  });

  it("does not treat Chrome or Firefox on a Mac as Safari", () => {
    expect(isMacSafariDevice(MAC_CHROME, guide)).toBe(false);
    expect(isMacSafariDevice(MAC_FIREFOX, guide)).toBe(false);
  });

  it("does not treat iPadOS in desktop mode as a Mac (it has touch)", () => {
    expect(isMacSafariDevice(IPADOS_DESKTOP_MODE, guide)).toBe(false);
  });

  it("does not treat Windows or iPhone as a Mac", () => {
    expect(isMacSafariDevice(WINDOWS, guide)).toBe(false);
    expect(isMacSafariDevice(IPHONE, guide)).toBe(false);
  });
});

describe("detectVoiceGuidePlatform", () => {
  it("returns ios for iPhone and iPad, including iPadOS desktop mode", () => {
    expect(detectVoiceGuidePlatform(IPHONE, guide)).toBe("ios");
    expect(detectVoiceGuidePlatform(IPAD, guide)).toBe("ios");
    expect(detectVoiceGuidePlatform(IPADOS_DESKTOP_MODE, guide)).toBe("ios");
  });

  it("returns mac for Safari on macOS", () => {
    expect(detectVoiceGuidePlatform(MAC_SAFARI, guide)).toBe("mac");
  });

  it("returns null for Chrome or Firefox on a Mac, Android and Windows", () => {
    expect(detectVoiceGuidePlatform(MAC_CHROME, guide)).toBeNull();
    expect(detectVoiceGuidePlatform(MAC_FIREFOX, guide)).toBeNull();
    expect(detectVoiceGuidePlatform(ANDROID, guide)).toBeNull();
    expect(detectVoiceGuidePlatform(WINDOWS, guide)).toBeNull();
  });
});

describe("stepsForPlatform", () => {
  it("uses the iOS steps for ios and the Mac steps for mac", () => {
    expect(stepsForPlatform(guide, "ios")).toBe(guide.steps);
    expect(stepsForPlatform(guide, "mac")).toBe(guide.mac_steps);
  });
});

describe("hasPremiumVoiceForLang", () => {
  it("is false when only basic voices exist for the page language", () => {
    expect(hasPremiumVoiceForLang(BASIC_ONLY, voiceSettings.lang, guide.premium_markers)).toBe(false);
  });

  it("is true for an Enhanced voice in the page language", () => {
    expect(hasPremiumVoiceForLang(WITH_ENHANCED, voiceSettings.lang, guide.premium_markers)).toBe(true);
  });

  it("is true for a Premium voice in the page language", () => {
    expect(hasPremiumVoiceForLang(WITH_PREMIUM, voiceSettings.lang, guide.premium_markers)).toBe(true);
  });

  it("ignores Enhanced voices in another language", () => {
    expect(hasPremiumVoiceForLang(ENHANCED_ONLY_NON_ENGLISH, voiceSettings.lang, guide.premium_markers)).toBe(false);
  });

  it("counts an English variant (en-GB) for an en-US page, as rankVoice does", () => {
    expect(hasPremiumVoiceForLang([v("Daniel (Enhanced)", "en-GB")], voiceSettings.lang, guide.premium_markers)).toBe(true);
  });

  it("is false for an empty voice list", () => {
    expect(hasPremiumVoiceForLang([], voiceSettings.lang, guide.premium_markers)).toBe(false);
  });
});

describe("shouldShowBasicVoiceGuide", () => {
  const base = {
    guide,
    voiceSettings,
    platform: "ios" as const,
    voices: BASIC_ONLY,
    speechSupported: true,
    dismissed: false,
  };

  it("shows on iOS when only basic voices exist", () => {
    expect(shouldShowBasicVoiceGuide(base)).toBe(true);
  });

  it("shows on Safari for macOS when only basic voices exist", () => {
    expect(shouldShowBasicVoiceGuide({ ...base, platform: "mac" })).toBe(true);
  });

  it("hides when an Enhanced or Premium voice exists, on either platform", () => {
    expect(shouldShowBasicVoiceGuide({ ...base, voices: WITH_ENHANCED })).toBe(false);
    expect(shouldShowBasicVoiceGuide({ ...base, voices: WITH_PREMIUM })).toBe(false);
    expect(shouldShowBasicVoiceGuide({ ...base, platform: "mac", voices: WITH_ENHANCED })).toBe(false);
  });

  it("hides when the device is neither iOS nor Safari on macOS", () => {
    expect(shouldShowBasicVoiceGuide({ ...base, platform: null })).toBe(false);
  });

  it("hides before the voice list has loaded (empty list is not evidence of a basic voice)", () => {
    expect(shouldShowBasicVoiceGuide({ ...base, voices: [] })).toBe(false);
  });

  it("hides when speech synthesis is unsupported", () => {
    expect(shouldShowBasicVoiceGuide({ ...base, speechSupported: false })).toBe(false);
  });

  it("hides when dismissed for this visit", () => {
    expect(shouldShowBasicVoiceGuide({ ...base, dismissed: true })).toBe(false);
  });

  it("hides when the registry switches the guide off", () => {
    expect(shouldShowBasicVoiceGuide({ ...base, guide: { ...guide, enabled: false } })).toBe(false);
  });
});

describe("registry copy for the voice guide", () => {
  it("carries the founder-approved text and four numbered iOS steps", () => {
    expect(guide.message).toBe(
      "Your device is using a basic voice. Apple offers a natural-sounding voice for free. Want to switch? It takes about 30 seconds.",
    );
    expect(guide.steps).toHaveLength(4);
    expect(guide.steps[3]).toBe("Download a voice marked Premium or Enhanced (e.g. Ava or Zoe), then come back here.");
  });

  it("carries the four Mac steps as a separate list", () => {
    expect(guide.mac_steps).toHaveLength(4);
    expect(guide.mac_steps[0]).toBe("Open System Settings.");
    expect(guide.mac_steps[2]).toBe("Next to System Voice, choose Manage Voices.");
    expect(guide.mac_steps[3]).toBe("Download a voice marked Premium or Enhanced (e.g. Ava or Zoe), then come back here.");
  });

  it("never claims the site downloads anything", () => {
    const all = [guide.message, ...guide.steps, ...guide.mac_steps, guide.retry_still_basic_message].join(" ");
    expect(all).not.toMatch(/we (will )?download|we download|downloads? (a|the) voice for you/i);
  });
});
