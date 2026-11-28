/**
 * Buyer download filename, per the release convention:
 *   <Publisher>_<ProductSlugCamel>_<CreatorName>_<Year>.pdf
 * e.g. ExpanPress_SampleTheQuietWorkshop_ExpanPress_2026.pdf
 *
 * Pure: the publisher is passed in by the caller (GLOBAL.storefront.brand_name in the route), never a literal here.
 * Output is ASCII-only, so it is safe in a Content-Disposition header.
 */

export interface ReleaseFilenameParts {
  slug: string | null | undefined;
  creatorDisplayName: string | null | undefined;
  releaseYear: number | null | undefined;
}

const WORD_BREAK = /[^A-Za-z0-9]+/;

/**
 * Folds accents to ASCII, splits on anything that is not a letter or digit, and capitalises each word.
 * "sample_the_quiet_workshop" -> "SampleTheQuietWorkshop"; "Jane Doe" -> "JaneDoe"; "Zoë Ångström" -> "ZoeAngstrom".
 */
export function toCamelSegment(text: string): string {
  return text
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
  if (typeof year !== "number" || !Number.isInteger(year) || year < 1900) return null;
  return `${publisherSegment}_${slugSegment}_${creatorSegment}_${year}.pdf`;
}
