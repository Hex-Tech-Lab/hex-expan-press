import type { BookPreviewReadAloudVoiceSettings } from "../../../../payments/src/settings_registry";

/** The two fields ranking reads. SpeechSynthesisVoice satisfies it; tests pass plain objects. */
export interface VoiceCandidate {
  name: string;
  lang: string;
}

function primarySubtag(lang: string): string {
  return (lang.toLowerCase().split(/[-_]/)[0] ?? "").trim();
}

function normalizeTag(lang: string): string {
  return lang.toLowerCase().replace(/_/g, "-");
}

/** Index of the earliest quality marker found in the name; markers.length when none match. */
function markerRank(name: string, markers: ReadonlyArray<string>): number {
  const lower = name.toLowerCase();
  let best = markers.length;
  markers.forEach((marker, index) => {
    if (index < best && lower.includes(marker.toLowerCase())) best = index;
  });
  return best;
}

/** Gender from whole name tokens, so "Ava" does not match "Avatar". Null when no hint matches. */
function voiceGender(name: string, settings: BookPreviewReadAloudVoiceSettings): "female" | "male" | null {
  const tokens = new Set(name.toLowerCase().split(/[^a-z]+/));
  const hits = (hints: ReadonlyArray<string>) => hints.some((hint) => tokens.has(hint.toLowerCase()));
  if (hits(settings.female_name_hints)) return "female";
  if (hits(settings.male_name_hints)) return "male";
  return null;
}

/**
 * Picks the best voice for the book language, or null so the browser default is used.
 * When `preferredGender` is specified ("male" or "female"), matching gender outranks quality markers so a
 * male-narrated audiobook fallback never jumps to a female "Online (Natural)" voice when a male voice exists.
 * Otherwise: exact book language, same primary subtag (en-*), quality markers, configured gender order, browser order.
 */
export function rankVoice<T extends VoiceCandidate>(
  voices: ReadonlyArray<T>,
  settings: BookPreviewReadAloudVoiceSettings,
  preferredGender?: "female" | "male" | null,
): T | null {
  const wantedTag = normalizeTag(settings.lang);
  const wantedPrimary = primarySubtag(settings.lang);
  let best: { voice: T; key: [number, number, number] } | null = null;

  for (const voice of voices) {
    if (primarySubtag(voice.lang) !== wantedPrimary) continue;
    const langTier = normalizeTag(voice.lang) === wantedTag ? 0 : 1;
    const gender = voiceGender(voice.name, settings);
    const quality = markerRank(voice.name, settings.quality_markers);
    let key: [number, number, number];
    if (preferredGender === "male" || preferredGender === "female") {
      const genderTier = gender === preferredGender ? 0 : gender === null ? 1 : 2;
      key = [langTier, genderTier, quality];
    } else {
      const genderIdx = gender ? settings.gender_order.indexOf(gender) : -1;
      const genderRank = genderIdx >= 0 ? genderIdx : settings.gender_order.length;
      key = [langTier, quality, genderRank];
    }
    if (!best || compareKeys(key, best.key) < 0) best = { voice, key };
  }
  return best?.voice ?? null;
}

function compareKeys(leftKey: readonly number[], rightKey: readonly number[]): number {
  for (let index = 0; index < leftKey.length; index++) {
    const difference = (leftKey[index] ?? 0) - (rightKey[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
