import type {
  BookPreviewReadAloudVoiceGuideSettings,
  BookPreviewReadAloudVoiceSettings,
} from "../../../../payments/src/settings_registry";
import { primarySubtag, type VoiceCandidate } from "./read-aloud-voice";

/** The navigator fields platform detection reads. Passed in so tests need no browser. */
export interface DeviceSignals {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

/** Which steps the card shows: iPhone and iPad share one list; Safari on macOS has its own. */
export type VoiceGuidePlatform = "ios" | "mac";

/**
 * True on iPhone, iPod and iPad. iPadOS in desktop-site mode reports a Macintosh UA and MacIntel,
 * but a real Mac has no touch points, so touch points separate the two.
 */
export function isIosDevice(device: DeviceSignals, guide: BookPreviewReadAloudVoiceGuideSettings): boolean {
  if (guide.device_tokens.some((token) => device.userAgent.includes(token))) return true;
  return device.platform === guide.ipados_platform && device.maxTouchPoints > 1;
}

/** True on Safari for macOS: a Macintosh UA, Safari in the UA, no other desktop browser token, and no touch. */
export function isMacSafariDevice(device: DeviceSignals, guide: BookPreviewReadAloudVoiceGuideSettings): boolean {
  if (!device.userAgent.includes(guide.mac_token)) return false;
  if (device.maxTouchPoints > 0) return false;
  if (!device.userAgent.includes(guide.mac_safari_token)) return false;
  return !guide.mac_excluded_tokens.some((token) => device.userAgent.includes(token));
}

/** The step list to show for this device, or null when the card does not apply (Android, Windows, Chrome on Mac, ...). */
export function detectVoiceGuidePlatform(
  device: DeviceSignals,
  guide: BookPreviewReadAloudVoiceGuideSettings,
): VoiceGuidePlatform | null {
  if (isIosDevice(device, guide)) return "ios";
  if (isMacSafariDevice(device, guide)) return "mac";
  return null;
}

/**
 * True when an installed voice in the page language carries a premium marker (Enhanced, Premium).
 * Language matches on the primary subtag, the same rule rankVoice uses, so en-GB counts for an en-US page.
 */
export function hasPremiumVoiceForLang(
  voices: ReadonlyArray<VoiceCandidate>,
  lang: string,
  premiumMarkers: ReadonlyArray<string>,
): boolean {
  const wanted = primarySubtag(lang);
  return voices.some((voice) => {
    if (primarySubtag(voice.lang) !== wanted) return false;
    const name = voice.name.toLowerCase();
    return premiumMarkers.some((marker) => name.includes(marker.toLowerCase()));
  });
}

export interface BasicVoiceGuideInput {
  guide: BookPreviewReadAloudVoiceGuideSettings;
  voiceSettings: BookPreviewReadAloudVoiceSettings;
  /** The platform from detectVoiceGuidePlatform, or null when the card does not apply. */
  platform: VoiceGuidePlatform | null;
  voices: ReadonlyArray<VoiceCandidate>;
  speechSupported: boolean;
  dismissed: boolean;
}

/**
 * The card shows only when: the guide is on, speech works, the device is iPhone, iPad or Safari on macOS,
 * the voice list has loaded (an empty list means not loaded yet, not a basic voice), no Enhanced or Premium
 * voice exists for the page language, and the reader has not dismissed it this visit.
 */
export function shouldShowBasicVoiceGuide(input: BasicVoiceGuideInput): boolean {
  const { guide, voiceSettings, platform, voices, speechSupported, dismissed } = input;
  if (!guide.enabled || !speechSupported || dismissed) return false;
  if (platform === null) return false;
  if (voices.length === 0) return false;
  return !hasPremiumVoiceForLang(voices, voiceSettings.lang, guide.premium_markers);
}

/** The step list for a platform. */
export function stepsForPlatform(guide: BookPreviewReadAloudVoiceGuideSettings, platform: VoiceGuidePlatform): ReadonlyArray<string> {
  return platform === "mac" ? guide.mac_steps : guide.steps;
}

/** Copies the fields ranking and detection read out of a SpeechSynthesisVoice list. */
export function toVoiceCandidates(voices: ArrayLike<{ name: string; lang: string }>): VoiceCandidate[] {
  return Array.from(voices, (voice) => ({ name: voice.name, lang: voice.lang }));
}
