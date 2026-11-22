import type { Orientation, PageFlip } from "page-flip";
import type {
  BookPreviewSettings,
  BookPreviewTextStructureSettings,
} from "../../../../payments/src/settings_registry";

export type PreviewZoomAction = "zoom_in" | "zoom_out" | "reset";

export interface PdfPageLike {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): {
    promise: Promise<void>;
    cancel?: () => void;
  };
  getTextContent(): Promise<{ items: PdfTextItemLike[] }>;
}

export interface PdfDocLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy?(): Promise<void>;
}

/** Compute the next zoom index within `zoomLevels`, clamped cleanly at bounds. */
export function resolveZoomIndex(
  currentIndex: number,
  action: PreviewZoomAction,
  zoomLevels: ReadonlyArray<number>,
): number {
  const maxIndex = Math.max(0, zoomLevels.length - 1);
  const clamped = Math.min(Math.max(0, currentIndex), maxIndex);
  if (action === "zoom_in") return Math.min(clamped + 1, maxIndex);
  if (action === "zoom_out") return Math.max(clamped - 1, 0);
  return 0;
}

/** Parse a 1-based page string into a clamped 0-based page index, or null when invalid. */
export function parseTargetPageInput(raw: string, totalPages: number): number | null {
  if (totalPages <= 0) return null;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsedPage = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsedPage)) return null;
  const clamped = Math.min(Math.max(1, parsedPage), totalPages);
  return clamped - 1;
}

/** Build StPageFlip spread groups matching PageCollection.createSpread(). */
export function buildSpreadGroups(totalPages: number, orientation: Orientation, showCover: boolean): number[][] {
  if (totalPages <= 0) return [];
  if (orientation === "portrait") {
    return Array.from({ length: totalPages }, (_, idx) => [idx]);
  }
  const spreads: number[][] = [];
  let start = 0;
  if (showCover) {
    spreads.push([0]);
    start = 1;
  }
  for (let i = start; i < totalPages; i += 2) {
    if (i < totalPages - 1) spreads.push([i, i + 1]);
    else spreads.push([i]);
  }
  return spreads;
}

export function spreadIndexForPage(spreads: number[][], pageIndex: number): number {
  const idx = spreads.findIndex((group) => group.includes(pageIndex));
  return idx >= 0 ? idx : 0;
}

export function formatSpreadLabel(spread: number[], totalPages: number, showCover: boolean): string {
  if (totalPages <= 0 || spread.length === 0) return "";
  if (spread.length === 1) {
    const pageNum = spread[0] + 1;
    if (showCover && pageNum === 1) return `Front cover · Page 1 of ${totalPages}`;
    if (showCover && pageNum === totalPages && totalPages > 1) return `Back cover · Page ${pageNum} of ${totalPages}`;
    return `Page ${pageNum} of ${totalPages}`;
  }
  return `Pages ${spread[0] + 1}–${spread[spread.length - 1] + 1} of ${totalPages}`;
}

type RenderLike = { drawFrame: () => void };

/** page-flip 2.0.7 has no pause or stop; override drawFrame on its render object while offscreen. */
export function setRenderPaused(flip: PageFlip | null, paused: boolean): void {
  const render = (flip as unknown as { render?: RenderLike } | null)?.render;
  if (!render) return;
  if (paused) render.drawFrame = () => {};
  else delete (render as Partial<RenderLike>).drawFrame;
}

export type RasterizedPreview = { images: string[]; pageBlocks: AccessibleBlock[][] };

/** Renders the first max_preview_pages pages to PNG data URLs and structured accessible text blocks. */
export async function rasterizePreview(
  previewPdfUrl: string,
  coverImageUrl: string | null,
  settings: BookPreviewSettings,
  isCancelled: () => boolean,
): Promise<RasterizedPreview | null> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = settings.pdf_worker_src;
  const doc = (await pdfjs.getDocument(previewPdfUrl).promise) as unknown as PdfDocLike;
  try {
    const count = Math.min(doc.numPages, settings.max_preview_pages);
    const images: string[] = [];
    const pageBlocks: AccessibleBlock[][] = [];
    for (let i = 1; i <= count; i++) {
      if (isCancelled()) return null;
      const pdfPage = await doc.getPage(i);
      if (isCancelled()) return null;
      const baseVp = pdfPage.getViewport({ scale: 1 });
      const targetScale = (settings.page_width_px * settings.render_scale) / Math.max(baseVp.width, 1);
      const vp = pdfPage.getViewport({ scale: targetScale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable");
      if (i === 1 && coverImageUrl) {
        images.push(coverImageUrl);
      } else {
        await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
        images.push(canvas.toDataURL("image/png"));
      }
      try {
        const tc = await pdfPage.getTextContent();
        pageBlocks.push(extractStructuredPageBlocks(tc.items, settings.text_structure, baseVp.height));
      } catch (err) {
        console.warn("[book-previewer] Failed to extract page text:", err);
        pageBlocks.push([]);
      }
    }
    return { images, pageBlocks };
  } finally {
    await doc.destroy?.();
  }
}

export interface PdfTextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
}

export type AccessibleBlock =
  | { kind: "heading"; level: 3 | 4; text: string }
  | { kind: "list-item"; text: string }
  | { kind: "paragraph"; text: string };

export interface ReadAloudChunk {
  id: string;
  pageIndex: number;
  blockIndex: number;
  text: string;
}

export type {
  PreviewAudioManifest,
  PreviewAudioPageTrack,
  PreviewAudioTimingChunk,
} from "./read-aloud-audio";

export interface AccessiblePageGroup {
  pageIndex: number;
  blocks: Array<{
    block: AccessibleBlock;
    blockIndex: number;
    chunks: ReadAloudChunk[];
  }>;
}

interface VisualLine {
  text: string;
  height: number;
  y: number | null;
}

const CHAPTER_LABEL_RE =
  /^(?:chapter|part|section|appendix)\b|^(?:c\s+h\s+a\s+p\s+t\s+e\s+r|p\s+a\s+r\s+t)\b/i;
const SYMBOL_BULLET_RE = /^[•●◦▪▫*-]\s+(.+)$/;
const NUMBERED_ITEM_RE = /^(\d{1,3}[.)]\s+.+)$/;
const DOT_LEADER_RE = /(?:\s*\.\s*){4,}/g;
const STANDALONE_ORDINAL_RE = /^\d{1,3}\.$/;
const FOLIO_DIGITS_RE = /^\d+$/;
const FOLIO_ROMAN_RE = /^[ivxlcdm]+$/i;

function isStandaloneMarginFolio(
  line: VisualLine,
  effectivePageHeight: number,
  contentBodyHeight: number,
  settings: BookPreviewTextStructureSettings,
): boolean {
  if (!settings.strip_margin_folios || line.y === null) return false;
  if (line.y > effectivePageHeight * settings.bottom_margin_ratio) return false;
  if (line.height > 0 && line.height > contentBodyHeight * settings.folio_max_scale_ratio) return false;
  const token = line.text.trim();
  if (!token) return false;
  if (FOLIO_DIGITS_RE.test(token)) return token.length <= settings.folio_max_digits;
  if (settings.allow_roman_folios && FOLIO_ROMAN_RE.test(token)) {
    return token.length <= settings.folio_roman_max_length;
  }
  return false;
}

function itemHeight(item: PdfTextItemLike): number {
  if (typeof item.height === "number" && Number.isFinite(item.height) && item.height > 0) {
    return item.height;
  }
  const t = item.transform;
  if (Array.isArray(t) && t.length >= 4) {
    const h = Math.hypot(t[2] ?? 0, t[3] ?? 0);
    if (Number.isFinite(h) && h > 0) return h;
  }
  return 0;
}

function itemY(item: PdfTextItemLike): number | null {
  const t = item.transform;
  if (Array.isArray(t) && t.length >= 6 && typeof t[5] === "number" && Number.isFinite(t[5])) {
    return t[5];
  }
  return null;
}

function cleanLineText(parts: string[]): string {
  return parts
    .join(" ")
    .replace(DOT_LEADER_RE, " — ")
    .replace(/\s+/g, " ")
    .trim();
}

function computeWeightedMedianHeight(lines: VisualLine[]): number {
  const weighted = lines
    .filter((l) => l.height > 0 && l.text.length > 0)
    .map((l) => ({ height: l.height, weight: Math.max(1, l.text.length) }))
    .sort((a, b) => a.height - b.height);
  if (weighted.length === 0) return 10;
  const totalWeight = weighted.reduce((acc, entry) => acc + entry.weight, 0);
  const half = totalWeight / 2;
  let running = 0;
  for (const entry of weighted) {
    running += entry.weight;
    if (running >= half) return entry.height;
  }
  return weighted[weighted.length - 1].height;
}

function groupItemsIntoLines(items: ReadonlyArray<PdfTextItemLike>, lineYTolerance: number): VisualLine[] {
  const rawLines: VisualLine[] = [];
  let parts: string[] = [];
  let heightWeightSum = 0;
  let totalWeight = 0;
  let lineY: number | null = null;
  let prevY: number | null = null;
  let forceBreak = false;

  const flushLine = () => {
    const text = cleanLineText(parts);
    if (text) {
      const avgHeight = totalWeight > 0 ? heightWeightSum / totalWeight : 0;
      rawLines.push({ text, height: avgHeight, y: lineY });
    }
    parts = [];
    heightWeightSum = 0;
    totalWeight = 0;
    lineY = null;
  };

  for (const item of items) {
    const token = (item.str ?? "").trim();
    const y = itemY(item);
    const yMoved = y !== null && prevY !== null && Math.abs(y - prevY) > lineYTolerance;
    if (parts.length > 0 && (forceBreak || yMoved)) {
      flushLine();
      forceBreak = false;
    }

    if (token) {
      parts.push(token);
      const h = itemHeight(item);
      if (h > 0) {
        heightWeightSum += h * token.length;
        totalWeight += token.length;
      }
      if (lineY === null && y !== null) lineY = y;
      if (y !== null) prevY = y;
    }

    if (item.hasEOL) {
      forceBreak = true;
    } else if (token) {
      forceBreak = false;
    }
  }
  flushLine();
  return rawLines;
}

function mergeDropCaps(lines: VisualLine[], bodyHeight: number, headingScaleRatio: number): VisualLine[] {
  const merged: VisualLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const next = lines[i + 1];
    if (
      next &&
      cur.text.length === 1 &&
      /^[A-Za-z]$/.test(cur.text) &&
      cur.height >= bodyHeight * headingScaleRatio &&
      /^[a-z]/.test(next.text)
    ) {
      merged.push({
        text: `${cur.text}${next.text}`,
        height: next.height,
        y: next.y,
      });
      i++;
      continue;
    }
    merged.push(cur);
  }
  return merged;
}

function classifyHeadingLevel(
  line: VisualLine,
  bodyHeight: number,
  settings: BookPreviewTextStructureSettings,
): 3 | 4 | null {
  if (line.text.length < 2 || line.text.length > settings.max_heading_chars) return null;
  if (!/[A-Za-z0-9]/.test(line.text)) return null;
  if (CHAPTER_LABEL_RE.test(line.text)) return 3;
  if (line.height <= 0) return null;
  if (line.height >= bodyHeight * settings.major_heading_scale_ratio) return 3;
  if (line.height >= bodyHeight * settings.heading_scale_ratio) return 4;
  return null;
}

function parseListItemText(text: string): string | null {
  const bulletMatch = SYMBOL_BULLET_RE.exec(text);
  if (bulletMatch) return bulletMatch[1].trim();
  const numMatch = NUMBERED_ITEM_RE.exec(text);
  if (numMatch) return numMatch[1].trim();
  return null;
}

/** Extract semantic blocks (headings, list items, paragraphs) from pdf.js text items using configurable thresholds. */
export function extractStructuredPageBlocks(
  items: ReadonlyArray<PdfTextItemLike>,
  settings: BookPreviewTextStructureSettings,
  pageHeight?: number,
): AccessibleBlock[] {
  const rawLines = groupItemsIntoLines(items, settings.line_y_tolerance);
  if (rawLines.length === 0) return [];
  const maxItemY = rawLines.reduce((max, line) => (line.y !== null && line.y > max ? line.y : max), 0);
  const effectivePageHeight =
    typeof pageHeight === "number" && Number.isFinite(pageHeight) && pageHeight > 0
      ? pageHeight
      : Math.max(settings.fallback_page_height_pt, maxItemY * 1.1);
  const nonMarginLines = rawLines.filter((line) => line.y === null || line.y > effectivePageHeight * settings.bottom_margin_ratio);
  const contentBodyHeight = Math.max(computeWeightedMedianHeight(nonMarginLines.length > 0 ? nonMarginLines : rawLines), 1);
  const filteredLines = rawLines.filter((line) => !isStandaloneMarginFolio(line, effectivePageHeight, contentBodyHeight, settings));
  if (filteredLines.length === 0) return [];
  const bodyHeight = Math.max(computeWeightedMedianHeight(filteredLines), 1);
  const lines = mergeDropCaps(filteredLines, bodyHeight, settings.heading_scale_ratio);
  const blocks: AccessibleBlock[] = [];
  let prevLine: VisualLine | null = null;
  for (const line of lines) {
    const yGap = prevLine && prevLine.y !== null && line.y !== null ? Math.abs(prevLine.y - line.y) : null;
    const headingLevel = classifyHeadingLevel(line, bodyHeight, settings);
    const prevBlock = blocks[blocks.length - 1];
    if (headingLevel !== null) {
      const sameHeadingLevel = prevBlock?.kind === "heading" && prevBlock.level === headingLevel;
      const refHeight = prevLine ? Math.min(prevLine.height || bodyHeight, line.height || bodyHeight) : bodyHeight;
      const withinHeadingLeading = yGap !== null && yGap <= Math.max(refHeight, 1) * settings.paragraph_gap_ratio;
      if (sameHeadingLevel && withinHeadingLeading && !CHAPTER_LABEL_RE.test(line.text)) {
        prevBlock.text = `${prevBlock.text} ${line.text}`.replace(/\s+/g, " ").trim();
      } else {
        blocks.push({ kind: "heading", level: headingLevel, text: line.text });
      }
      prevLine = line;
      continue;
    }
    const listText = parseListItemText(line.text);
    if (listText !== null) {
      blocks.push({ kind: "list-item", text: listText });
      prevLine = line;
      continue;
    }
    const normalLeading = yGap === null || yGap <= bodyHeight * settings.paragraph_gap_ratio;
    if ((prevBlock?.kind === "list-item" || prevBlock?.kind === "paragraph") && normalLeading) {
      prevBlock.text = `${prevBlock.text} ${line.text}`.replace(/\s+/g, " ").trim();
    } else {
      blocks.push({ kind: "paragraph", text: line.text });
    }
    prevLine = line;
  }
  return blocks;
}

/** Split a text block into sentence-level chunks capped at maxChunkChars to avoid Chrome's ~15s TTS stall bug. */
export function splitIntoSentenceChunks(text: string, maxChunkChars: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const cap = Math.max(20, Math.floor(maxChunkChars));

  const rawSentences = normalized.match(/[^.!?]+(?:[.!?]+["'”’)]*)?|.+$/g) ?? [normalized];
  const sentences: string[] = [];
  for (let i = 0; i < rawSentences.length; i++) {
    const cur = rawSentences[i].trim();
    if (!cur) continue;
    if (STANDALONE_ORDINAL_RE.test(cur) && i + 1 < rawSentences.length) {
      const next = rawSentences[i + 1].trim();
      if (next) {
        sentences.push(`${cur} ${next}`);
        i++;
        continue;
      }
    }
    sentences.push(cur);
  }
  const chunks: string[] = [];

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    if (sentence.length <= cap) {
      chunks.push(sentence);
      continue;
    }

    let remaining = sentence;
    while (remaining.length > cap) {
      const slice = remaining.slice(0, cap + 1);
      const clauseCut = Math.max(slice.lastIndexOf("; "), slice.lastIndexOf(": "), slice.lastIndexOf(", "));
      const wordCut = slice.lastIndexOf(" ");
      const cutAt = clauseCut >= Math.floor(cap * 0.4) ? clauseCut + 1 : wordCut > 0 ? wordCut : cap;
      const head = remaining.slice(0, cutAt).trim();
      if (head) chunks.push(head);
      remaining = remaining.slice(cutAt).trim();
    }
    if (remaining) chunks.push(remaining);
  }

  return chunks;
}

/** Build ordered sentence chunks and grouped block structures for the currently visible spread. */
export function buildSpreadAccessibleModel(
  spreadPages: ReadonlyArray<number>,
  pageBlocks: ReadonlyArray<ReadonlyArray<AccessibleBlock>>,
  maxChunkChars: number,
): { pages: AccessiblePageGroup[]; chunks: ReadAloudChunk[] } {
  const pages: AccessiblePageGroup[] = [];
  const chunks: ReadAloudChunk[] = [];

  for (const pageIndex of spreadPages) {
    const rawBlocks = pageBlocks[pageIndex] ?? [];
    if (rawBlocks.length === 0) continue;
    const groupedBlocks: AccessiblePageGroup["blocks"] = [];

    for (let blockIndex = 0; blockIndex < rawBlocks.length; blockIndex++) {
      const block = rawBlocks[blockIndex];
      const parts = splitIntoSentenceChunks(block.text, maxChunkChars);
      const blockChunks: ReadAloudChunk[] = parts.map((part, sentenceIdx) => {
        const chunk: ReadAloudChunk = {
          id: `p${pageIndex}-b${blockIndex}-s${sentenceIdx}`,
          pageIndex,
          blockIndex,
          text: part,
        };
        chunks.push(chunk);
        return chunk;
      });
      groupedBlocks.push({ block, blockIndex, chunks: blockChunks });
    }

    pages.push({ pageIndex, blocks: groupedBlocks });
  }

  return { pages, chunks };
}
