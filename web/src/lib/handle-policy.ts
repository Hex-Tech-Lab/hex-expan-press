// Creator handle policy, modelled on Instagram: letters, digits and underscores only, 3 to 30 characters.
// Set once at account creation, then immutable. Input may be CamelCase; it is stored lowercase, because
// Instagram treats usernames as case-insensitive and our URLs (/books/{handle}) are lowercase.
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";
import { GLOBAL } from "../../../payments/src/settings_registry";

// Length bounds and reserved words come from the settings registry (handles section), never from this file.
export const HANDLE_MIN = GLOBAL.handles.min_length;
export const HANDLE_MAX = GLOBAL.handles.max_length;
const HANDLE_CHARS = /^[a-z0-9_]+$/;
const RESERVED_HANDLES: ReadonlySet<string> = new Set(GLOBAL.handles.reserved);

// Whitelist comes from the registry and is merged WITH the preset's own whitelist, not replacing it.
const presetDataset = englishDataset.build();
const profanity = new RegExpMatcher({
  ...presetDataset,
  whitelistedTerms: [...(presetDataset.whitelistedTerms ?? []), ...GLOBAL.handles.profanity_whitelist],
  ...englishRecommendedTransformers,
});

export type HandleCheck =
  | { ok: true; handle: string }
  | { ok: false; reason: "format" | "reserved" | "profanity" };

/** Lowercases and checks one candidate handle. Returns the canonical (lowercase) handle when it passes. */
export function checkHandle(input: string): HandleCheck {
  const handle = input.trim().toLowerCase();
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) return { ok: false, reason: "format" };
  if (!HANDLE_CHARS.test(handle)) return { ok: false, reason: "format" };
  if (RESERVED_HANDLES.has(handle)) return { ok: false, reason: "reserved" };
  // Underscores are legal separators, so "f_u_c_k" must be checked with them removed as well.
  const squashed = handle.replace(/_/g, "");
  if (profanity.hasMatch(handle) || (squashed !== handle && profanity.hasMatch(squashed))) return { ok: false, reason: "profanity" };
  return { ok: true, handle };
}
