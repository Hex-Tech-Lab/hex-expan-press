// Creator handle policy: format, reserved words, profanity. Set once at account creation, then immutable.
// Profanity matching uses the `obscenity` library (English preset: obfuscation transformers + whitelist).
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";
import { GLOBAL } from "../../../payments/src/settings_registry";

// Length bounds and reserved words come from the settings registry (handles section), never from this file.
export const HANDLE_MIN = GLOBAL.handles.min_length;
export const HANDLE_MAX = GLOBAL.handles.max_length;
const HANDLE_CHARS = /^[a-z0-9._]+$/;
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(GLOBAL.handles.reserved);

// Ordinary words that contain a blacklisted substring. Merged WITH the preset's own whitelist, not replacing it.
const OUR_WHITELIST = ["classic", "assess", "assessment", "assist", "assistant", "assume", "bass", "class", "glass", "grass", "pass", "passage"];
const presetDataset = englishDataset.build();
const profanity = new RegExpMatcher({
  ...presetDataset,
  whitelistedTerms: [...(presetDataset.whitelistedTerms ?? []), ...OUR_WHITELIST],
  ...englishRecommendedTransformers,
});

export type HandleCheck =
  | { ok: true; handle: string }
  | { ok: false; reason: "format" | "reserved" | "profanity" };

/** Normalises (trim, lowercase: handles are case-insensitive) and checks one candidate handle. */
export function checkHandle(input: string): HandleCheck {
  const handle = input.trim().toLowerCase();
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) return { ok: false, reason: "format" };
  if (!HANDLE_CHARS.test(handle)) return { ok: false, reason: "format" };
  if (handle.startsWith(".") || handle.endsWith(".") || handle.includes("..")) return { ok: false, reason: "format" };
  if (RESERVED_HANDLES.has(handle)) return { ok: false, reason: "reserved" };
  // Dots and underscores are legal separators, so "f.u.c.k" must be checked with them removed as well.
  if (profanity.hasMatch(handle) || profanity.hasMatch(handle.replace(/[._]/g, ""))) return { ok: false, reason: "profanity" };
  return { ok: true, handle };
}
