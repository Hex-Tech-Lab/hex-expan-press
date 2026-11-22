import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as pdfjs from "../node_modules/pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";
import {
  buildSpreadAccessibleModel,
  extractStructuredPageBlocks,
  splitIntoSentenceChunks,
} from "../src/components/storefront/book-previewer-text";

async function extractPdfPages(relPath: string) {
  const repoRoot = resolve(__dirname, "..", "..");
  const data = new Uint8Array(readFileSync(resolve(repoRoot, relPath)));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  try {
    const pages: Array<{
      pdfPageNumber: number;
      height: number;
      blocks: ReturnType<typeof extractStructuredPageBlocks>;
      chunks: string[];
    }> = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const blocks = extractStructuredPageBlocks(
        tc.items as Parameters<typeof extractStructuredPageBlocks>[0],
        DEFAULT_GLOBAL.book_preview.text_structure,
        vp.height,
      );
      const chunks = blocks.flatMap((b) =>
        splitIntoSentenceChunks(b.text, DEFAULT_GLOBAL.book_preview.read_aloud.max_chunk_chars),
      );
      pages.push({ pdfPageNumber: p, height: vp.height, blocks, chunks });
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

describe("F-folio: margin page number stripping on real preview PDFs", () => {
  it("strips standalone footer folios across all 8 pages of sample_the_quiet_workshop.pdf while preserving inline numbers", async () => {
    const pages = await extractPdfPages("web/public/books/previews/sample_the_quiet_workshop.pdf");
    expect(pages).toHaveLength(8);

    // None of the bare footer folio numbers (3, 4, 5, 6, 8) appear as standalone blocks or chunks.
    const folioTargets = new Set(["3", "4", "5", "6", "8"]);
    for (const page of pages) {
      for (const block of page.blocks) {
        expect(folioTargets.has(block.text.trim()), `page ${page.pdfPageNumber} leaked folio block ${block.text}`).toBe(
          false,
        );
      }
      for (const chunk of page.chunks) {
        expect(folioTargets.has(chunk.trim()), `page ${page.pdfPageNumber} leaked folio chunk ${chunk}`).toBe(false);
      }
    }

    // Specific F-folio assertions:
    // Page 2 keeps "Sample: Chapter 1 of 12"
    expect(pages[1].chunks).toContain("Sample: Chapter 1 of 12");
    // Page 3 (Contents): keeps all 12 numbered items as single chunks without splitting "1." into its own chunk, and drops "3"
    expect(pages[2].blocks).toHaveLength(13);
    expect(pages[2].chunks).toHaveLength(13);
    expect(pages[2].chunks[1]).toMatch(/^1\. Setting Up the Bench:/);
    expect(pages[2].chunks[12]).toMatch(/^12\. Keeping the Workshop Going:/);
    expect(pages[2].chunks[pages[2].chunks.length - 1]).not.toBe("3");

    // Page 4: keeps heading + Figure 1 caption, drops "4"
    expect(pages[3].blocks.map((b) => b.text)).toEqual([
      "Chapter 1: Setting Up the Bench",
      "Figure 1: A quiet corner of a home workshop, with daylight and a bench of hand tools",
    ]);

    // Page 5 -> Page 6 mid-sentence wrap: "from the side" -> "opposite your dominant hand", without "[5]" between them
    const p5LastChunk = pages[4].chunks[pages[4].chunks.length - 1];
    const p6FirstChunk = pages[5].chunks[0];
    expect(p5LastChunk.endsWith("from the side")).toBe(true);
    expect(p6FirstChunk.startsWith("opposite your dominant hand")).toBe(true);

    // Page 6 ends on "second-guess.", not "6"
    expect(pages[5].chunks[pages[5].chunks.length - 1].endsWith("second-guess.")).toBe(true);

    // Page 7 (book page 8): ends on "first exercise.", not "8"
    expect(pages[6].chunks[pages[6].chunks.length - 1].endsWith("first exercise.")).toBe(true);

    // Page 8 (back cover): preserves "Sample: Chapter 1 of 12", "Trim 6 × 9 in Language English", and "ExpanPress | MMXXVI"
    const p8Joined = pages[7].chunks.join(" ");
    expect(p8Joined).toContain("Sample: Chapter 1 of 12");
    expect(p8Joined).toContain("6 × 9 in");
    expect(p8Joined).toContain("ExpanPress | MMXXVI");

    // Spread chunk IDs match 1:1 with buildSpreadAccessibleModel
    const spreadModel = buildSpreadAccessibleModel(
      [1, 2],
      pages.map((p) => p.blocks),
      DEFAULT_GLOBAL.book_preview.read_aloud.max_chunk_chars,
    );
    expect(spreadModel.chunks.map((c) => c.id)).toContain("p2-b1-s0");
    expect(spreadModel.chunks.every((c) => !folioTargets.has(c.text.trim()))).toBe(true);

    // Pre-baked timings.json and MP3 assets align 1:1 with folio-stripped extracted chunks across all 8 pages
    const repoRoot = resolve(__dirname, "..", "..");
    const timingsRaw = JSON.parse(
      readFileSync(resolve(repoRoot, "web/public/books/audio/sample_the_quiet_workshop/timings.json"), "utf8"),
    ) as {
      voiceId: string;
      pages: Record<
        string,
        { audioUrl: string; durationMs: number; chunks: Array<{ id: string; text: string; startMs: number; endMs: number }> }
      >;
    };
    expect(timingsRaw.voiceId).toBe(DEFAULT_GLOBAL.voice_narration.default_voice_id);
    for (let idx = 0; idx < pages.length; idx++) {
      const pdfPage = idx + 1;
      const pageModel = buildSpreadAccessibleModel(
        [idx],
        pages.map((p) => p.blocks),
        DEFAULT_GLOBAL.book_preview.read_aloud.max_chunk_chars,
      );
      const track = timingsRaw.pages[String(pdfPage)];
      expect(track, `missing timings track for PDF page ${pdfPage}`).toBeDefined();
      expect(track.audioUrl).toBe(`/books/audio/sample_the_quiet_workshop/page-0${pdfPage}.mp3`);
      expect(readFileSync(resolve(repoRoot, "web/public", track.audioUrl.replace(/^\//, ""))).length).toBeGreaterThan(10_000);
      expect(track.chunks.map((c) => ({ id: c.id, text: c.text }))).toEqual(
        pageModel.chunks.map((c) => ({ id: c.id, text: c.text })),
      );
      let prevEnd = 0;
      for (const tc of track.chunks) {
        expect(tc.startMs).toBeGreaterThanOrEqual(prevEnd);
        expect(tc.endMs).toBeGreaterThan(tc.startMs);
        expect(tc.endMs).toBeLessThanOrEqual(track.durationMs + 50);
        prevEnd = tc.endMs;
      }
    }
  });

  it("strips roman and arabic footer folios on duane.pdf while preserving inline numbers and figures", async () => {
    const pages = await extractPdfPages("web/public/books/previews/duane.pdf");
    expect(pages).toHaveLength(12);
    expect(pages[1].blocks.some((b) => b.text.trim().toLowerCase() === "iii")).toBe(false);
    for (const [idx, folio] of [
      [4, "2"],
      [5, "3"],
      [6, "4"],
      [7, "5"],
      [8, "6"],
      [9, "7"],
    ] as const) {
      expect(pages[idx].blocks.some((b) => b.text.trim() === folio)).toBe(false);
    }
    expect(pages[8].chunks.join(" ")).toContain("Repeat lines 1 through 6 each year");
  });

  it("preserves numbers in the main body area and respects strip_margin_folios=false", () => {
    const ts = DEFAULT_GLOBAL.book_preview.text_structure;
    const items = [
      { str: "Main body line above margin.", hasEOL: true, height: 11.5, transform: [11.5, 0, 0, 11.5, 68, 120] },
      { str: "2", hasEOL: true, height: 11.5, transform: [11.5, 0, 0, 11.5, 68, 90] },
      { str: "5", hasEOL: false, height: 8.5, transform: [8.5, 0, 0, 8.5, 220, 35.8] },
    ];
    const stripped = extractStructuredPageBlocks(items, ts, 648);
    expect(stripped.map((b) => b.text)).toEqual(["Main body line above margin.", "2"]);

    const unstripped = extractStructuredPageBlocks(items, { ...ts, strip_margin_folios: false }, 648);
    expect(unstripped.map((b) => b.text)).toEqual(["Main body line above margin.", "2", "5"]);
  });
});
