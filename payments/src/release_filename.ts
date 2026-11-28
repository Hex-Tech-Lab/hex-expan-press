/**
 * Buyer download filename, per the release convention:
 *   <Publisher>_<ProductSlugCamel>_<CreatorName>_<Year>.pdf
 * e.g. ExpanPress_SampleTheQuietWorkshop_ExpanPress_2026.pdf
 *
 * Pure: the publisher is passed in by the caller (GLOBAL.storefront.brand_name in the route), never a literal here.
 * The oldest valid year comes from the settings registry (delivery.release_filename_min_year).
 * Output is ASCII-only, so it is safe in a Content-Disposition header.
 */
import { GLOBAL } from "./settings_registry.ts";

export interface ReleaseFilenameParts {
  slug: string | null | undefined;
  creatorDisplayName: string | null | undefined;
  releaseYear: number | null | undefined;
}

const WORD_BREAK = /[^A-Za-z0-9]+/;

/** Letters that NFKD cannot decompose into a base letter plus a mark. Without this table, "Søren" loses its "ø". */
const TRANSLITERATIONS: Record<string, string> = {
  ø: "o", Ø: "O", ß: "ss", ẞ: "SS", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ł: "l", Ł: "L",
  đ: "d", Đ: "D", ð: "d", Ð: "D", þ: "th", Þ: "Th", ı: "i", ŋ: "ng", Ŋ: "NG", ħ: "h", Ħ: "H", ŧ: "t", Ŧ: "T", ƒ: "f",
};
const TRANSLITERATION_PATTERN = new RegExp(`[${Object.keys(TRANSLITERATIONS).join("")}]`, "gu");

/**
 * Transliterates, folds accents to ASCII, splits on anything that is not a letter or digit, and capitalises each word.
 * "sample_the_quiet_workshop" -> "SampleTheQuietWorkshop"; "Jane Doe" -> "JaneDoe"; "Zoë Ångström" -> "ZoeAngstrom";
 * "Søren Kierkegaard" -> "SorenKierkegaard"; "Straße" -> "Strasse"; "Łukasz" -> "Lukasz".
 */
export function toCamelSegment(text: string): string {
  return text
    .replace(TRANSLITERATION_PATTERN, (ch) => TRANSLITERATIONS[ch] ?? ch)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(WORD_BREAK)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/**
 * Returns the convention filename, or null when any part is missing or invalid.
 * The caller logs a null and serves under the storage key name, so a data gap never blocks a buyer.
 */
export function releaseDownloadFilename(publisher: string, parts: ReleaseFilenameParts): string | null {
  const publisherSegment = toCamelSegment(publisher);
  const slugSegment = toCamelSegment(parts.slug ?? "");
  const creatorSegment = toCamelSegment(parts.creatorDisplayName ?? "");
  const year = parts.releaseYear;
  if (!publisherSegment || !slugSegment || !creatorSegment) return null;
  if (typeof year !== "number" || !Number.isInteger(year) || year < GLOBAL.delivery.release_filename_min_year) return null;
  return `${publisherSegment}_${slugSegment}_${creatorSegment}_${year}.pdf`;
}
