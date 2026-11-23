import type { BookPreviewPageLandmarkLabels } from "../../../../payments/src/settings_registry";
import type { AccessibleBlock, ReadAloudChunk } from "./book-previewer-text";

export type PageLandmarkKind = keyof BookPreviewPageLandmarkLabels;

const TOC_HEADING_RE = /^(?:table\s+of\s+)?contents$/i;
const PART_OPENER_RE = /^part\b/i;
const CHAPTER_OPENER_RE = /^chapter\b/i;
const SELF_ANNOUNCING_RE = /^(?:chapter|part|contents|table\s+of\s+contents|front\s+cover|title\s+page|back\s+cover)\b/i;
const TITLE_METADATA_CUE_RE = /\b(?:pen\s+name|published\s+by|copyright|isbn|edition)\b/i;

/** Classifies a preview page's structural landmark role (cover, title page, TOC, part/chapter opener, back cover). */
export function classifyPageLandmarkKind(
  pageIndex: number,
  totalPages: number,
  blocks: ReadonlyArray<AccessibleBlock>,
  showCover: boolean,
): PageLandmarkKind | null {
  if (showCover && pageIndex === 0) return "front_cover";
  if (showCover && totalPages > 1 && pageIndex === totalPages - 1) return "back_cover";

  const firstBlock = blocks[0];
  const firstText = firstBlock?.text.trim() ?? "";
  if (firstBlock?.kind === "heading" && TOC_HEADING_RE.test(firstText)) return "table_of_contents";
  if (PART_OPENER_RE.test(firstText)) return "part_opener";
  if (CHAPTER_OPENER_RE.test(firstText)) return "chapter_opener";

  if (pageIndex === 1) return "title_page";
  if (pageIndex > 1 && pageIndex <= 3 && blocks.some((block) => TITLE_METADATA_CUE_RE.test(block.text))) {
    return "title_page";
  }
  return null;
}

/** Resolves the configured human-readable landmark label for a page, or null if none applies. */
export function classifyPageLandmark(
  pageIndex: number,
  totalPages: number,
  blocks: ReadonlyArray<AccessibleBlock>,
  showCover: boolean,
  labels: BookPreviewPageLandmarkLabels,
): string | null {
  const kind = classifyPageLandmarkKind(pageIndex, totalPages, blocks, showCover);
  return kind ? labels[kind] : null;
}

/**
 * Only non-self-announcing structural frames (front cover, title page, back cover) need an explicit
 * spoken prefix in TTS; TOC ("Contents.") and Part/Chapter openers already announce themselves.
 */
export function shouldSpeakPageLandmark(kind: PageLandmarkKind | null): boolean {
  return kind === "front_cover" || kind === "title_page" || kind === "back_cover";
}

/** Prepends a spoken landmark sentence (e.g. "Title page.") unless the chunk already self-announces. */
export function prependSpokenLandmark(
  spokenText: string,
  landmarkLabel: string | null,
  speakLandmark: boolean,
): string {
  if (!speakLandmark || !landmarkLabel) return spokenText;
  const trimmedSpoken = spokenText.trim();
  const trimmedLabel = landmarkLabel.trim();
  if (!trimmedSpoken || !trimmedLabel) return spokenText;
  if (SELF_ANNOUNCING_RE.test(trimmedSpoken)) return spokenText;
  const cue = /[.!?…]$/.test(trimmedLabel) ? trimmedLabel : `${trimmedLabel}.`;
  return `${cue} ${trimmedSpoken}`;
}

/** Builds per-page display landmarks and Web Speech chunks with spoken landmark prefixes on cover/title/back cover. */
export function enrichSpreadWithLandmarks(
  spreadPages: ReadonlyArray<number>,
  pageBlocks: ReadonlyArray<ReadonlyArray<AccessibleBlock>>,
  totalPages: number,
  showCover: boolean,
  labels: BookPreviewPageLandmarkLabels,
  chunks: ReadonlyArray<ReadAloudChunk>,
): { pageLandmarks: Record<number, string>; chunks: ReadAloudChunk[] } {
  const pageLandmarks: Record<number, string> = {};
  const spokenPrefixByPage = new Map<number, string>();

  for (const pageIdx of spreadPages) {
    const blocks = pageBlocks[pageIdx] ?? [];
    const kind = classifyPageLandmarkKind(pageIdx, totalPages, blocks, showCover);
    if (!kind) continue;
    const label = labels[kind];
    pageLandmarks[pageIdx] = label;
    if (shouldSpeakPageLandmark(kind)) {
      spokenPrefixByPage.set(pageIdx, label);
    }
  }

  const seenPages = new Set<number>();
  const enrichedChunks = chunks.map((chunk) => {
    if (seenPages.has(chunk.pageIndex)) return chunk;
    seenPages.add(chunk.pageIndex);
    const label = spokenPrefixByPage.get(chunk.pageIndex);
    if (!label) return chunk;
    const spoken = prependSpokenLandmark(chunk.text, label, true);
    return spoken !== chunk.text ? { ...chunk, spokenText: spoken } : chunk;
  });

  return { pageLandmarks, chunks: enrichedChunks };
}
