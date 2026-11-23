import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";
import type { PreviewAudioManifest } from "../../web/src/components/storefront/read-aloud-audio";
import {
  evaluateThesisPairProsody,
  extractF0Contour,
  runLayer1TextLexicon,
  runLayer2ThesisGap,
  runLayer4MasteringTiming,
} from "../audio_qa_layers";
import { resolvePreviewTotalPages, runLayer5PersonaScorecard } from "../audio_qa";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeSineFrames(freqHz: number, durationSec: number, sr = 24000): Float32Array {
  const n = Math.round(sr * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 0.25 * Math.sin((2 * Math.PI * freqHz * i) / sr);
  }
  return out;
}

const BASE_MANIFEST: PreviewAudioManifest = {
  version: 1,
  bookId: "test_book",
  voiceId: "c9f39b88-235b-4c2a-851c-3734ce1203be",
  voiceName: "Walter",
  voiceGender: "male",
  model: "qwen3-tts",
  sampleRateHz: 48000,
  loudnormLufs: -16,
  generatedAt: "2026-11-23T00:00:00.000Z",
  pages: {
    "1": {
      pageIndex: 0,
      pdfPageNumber: 1,
      audioUrl: "/books/audio/test_book/page-01.webm",
      durationMs: 3000,
      chunks: [{ id: "p0-b0-s0", blockIndex: 0, text: "The Quiet Workshop", spokenText: "Front cover. The Quiet Workshop.", startMs: 120, endMs: 2800 }],
    },
    "2": {
      pageIndex: 1,
      pdfPageNumber: 2,
      audioUrl: "/books/audio/test_book/page-02.webm",
      durationMs: 3200,
      chunks: [{ id: "p1-b0-s0", blockIndex: 0, text: "The Quiet Workshop", spokenText: "Title page. The Quiet Workshop.", startMs: 120, endMs: 3000 }],
    },
    "5": {
      pageIndex: 4,
      pdfPageNumber: 5,
      audioUrl: "/books/audio/test_book/page-05.webm",
      durationMs: 9000,
      chunks: [
        { id: "p4-b0-s0", blockIndex: 0, text: "A workshop does not need a room.", spokenText: "A workshop does not need a room.", startMs: 120, endMs: 1883 },
        { id: "p4-b0-s1", blockIndex: 0, text: "It needs a place where you can leave a project half finished without losing it.", spokenText: "It needs a place where you can leave a project half finished without losing it.", startMs: 2343, endMs: 8500 },
      ],
    },
  },
};

describe("5-layer Onion Audio QA Gate", () => {
  it("L1 catches missing Title page landmark, un-substituted lexicon tokens, Roman years, and bare folios", () => {
    const ok = runLayer1TextLexicon(
      BASE_MANIFEST,
      {
        "1": [{ kind: "heading", level: 3, text: "The Quiet Workshop" }],
        "2": [{ kind: "heading", level: 3, text: "The Quiet Workshop" }],
        "5": [{ kind: "paragraph", text: "A workshop does not need a room. It needs a place." }],
      },
      3,
      true,
      DEFAULT_GLOBAL.book_preview.text_structure,
      DEFAULT_GLOBAL.voice_narration,
    );
    expect(ok.passed).toBe(true);

    const badManifest: PreviewAudioManifest = {
      ...BASE_MANIFEST,
      pages: {
        ...BASE_MANIFEST.pages,
        "2": {
          ...BASE_MANIFEST.pages["2"],
          chunks: [
            { id: "p1-b0-s0", blockIndex: 0, text: "The Quiet Workshop", spokenText: "The Quiet Workshop.", startMs: 120, endMs: 2000 },
            { id: "p1-b1-s0", blockIndex: 1, text: "ExpanPress | MMXXVI", spokenText: "ExpanPress | MMXXVI", startMs: 2220, endMs: 2900 },
            { id: "p1-b2-s0", blockIndex: 2, text: "12", spokenText: "12", startMs: 3000, endMs: 3150 },
          ],
        },
      },
    };
    const bad = runLayer1TextLexicon(
      badManifest,
      { "1": [{ kind: "heading", level: 3, text: "The Quiet Workshop" }], "2": [{ kind: "heading", level: 3, text: "The Quiet Workshop" }] },
      3,
      true,
      DEFAULT_GLOBAL.book_preview.text_structure,
      DEFAULT_GLOBAL.voice_narration,
    );
    expect(bad.passed).toBe(false);
    expect(bad.failures.some((f) => f.includes('missing spoken landmark "Title page."'))).toBe(true);
    expect(bad.failures.some((f) => f.includes('un-substituted lexicon term "ExpanPress"'))).toBe(true);
    expect(bad.failures.some((f) => f.includes("unexpanded Roman year"))).toBe(true);
    expect(bad.failures.some((f) => f.includes("bare margin folio"))).toBe(true);
  });

  it("L2 enforces >= 440ms opening thesis gap and rejects 220ms rush", () => {
    const pass = runLayer2ThesisGap(BASE_MANIFEST, DEFAULT_GLOBAL.voice_narration);
    expect(pass.passed).toBe(true);

    const rushed: PreviewAudioManifest = {
      ...BASE_MANIFEST,
      pages: {
        "5": {
          ...BASE_MANIFEST.pages["5"],
          chunks: [
            BASE_MANIFEST.pages["5"].chunks[0],
            { ...BASE_MANIFEST.pages["5"].chunks[1], startMs: 1883 + 220 },
          ],
        },
      },
    };
    const fail = runLayer2ThesisGap(rushed, DEFAULT_GLOBAL.voice_narration);
    expect(fail.passed).toBe(false);
    expect(fail.failures[0]).toContain("thesis pause 220ms < required 440ms");
  });

  it("L3 catches 214 Hz onset spikes and non-final 88 Hz continuation tails, while passing calibrated baritone contours", () => {
    const goodS0Pcm = new Float32Array(24000);
    goodS0Pcm.set(makeSineFrames(98, 0.7), 0);
    goodS0Pcm.set(makeSineFrames(74, 0.3), 16800);
    const goodS1Pcm = makeSineFrames(132, 1.0);
    const goodRes = evaluateThesisPairProsody(
      "5",
      "p4-b0-s0",
      "p4-b0-s1",
      extractF0Contour(goodS0Pcm),
      extractF0Contour(goodS1Pcm),
    );
    expect(goodRes.failures).toEqual([]);
    expect(goodRes.s1OnsetMaxHz).toBeLessThanOrEqual(140);

    const spikeS1Pcm = makeSineFrames(214, 0.8);
    const flatS0Pcm = makeSineFrames(90, 0.8);
    const badRes = evaluateThesisPairProsody(
      "5",
      "p4-b0-s0",
      "p4-b0-s1",
      extractF0Contour(flatS0Pcm),
      extractF0Contour(spikeS1Pcm),
    );
    expect(badRes.failures.some((f) => f.includes("onset F0 spike"))).toBe(true);
    expect(badRes.failures.some((f) => f.includes("non-final terminal inflection"))).toBe(true);

    // PRRT_kwDOUrokqs665SeE: silent/unvoiced audio must fail L3 instead of slipping through with empty F0 contours
    const silent = new Float32Array(24000);
    const silentRes = evaluateThesisPairProsody(
      "5",
      "p4-b0-s0",
      "p4-b0-s1",
      extractF0Contour(silent),
      extractF0Contour(silent),
    );
    expect(silentRes.failures.length).toBe(2);
    expect(silentRes.failures.every((f) => f.includes("insufficient voiced F0 frames"))).toBe(true);
  });

  it("L1 resolves preview totalPages from PDF count even when blank pages are omitted from manifest", () => {
    // PRRT_kwDOUrokqs665SeO: 5-page preview with blank page 3 omitted must yield totalPages=5 (not manifest key count 4)
    const sparseManifest: PreviewAudioManifest = {
      ...BASE_MANIFEST,
      pages: {
        "1": BASE_MANIFEST.pages["1"],
        "2": BASE_MANIFEST.pages["2"],
        "4": {
          pageIndex: 3,
          pdfPageNumber: 4,
          audioUrl: "/books/audio/test_book/page-04.webm",
          durationMs: 3000,
          chunks: [{ id: "p3-b0-s0", blockIndex: 0, text: "Chapter 1: Bench", startMs: 120, endMs: 2500 }],
        },
      },
    };
    expect(resolvePreviewTotalPages(sparseManifest, 5)).toBe(5);
    const l1 = runLayer1TextLexicon(
      sparseManifest,
      {
        "1": [{ kind: "heading", level: 3, text: "The Quiet Workshop" }],
        "2": [{ kind: "heading", level: 3, text: "The Quiet Workshop" }],
        "4": [{ kind: "heading", level: 3, text: "Chapter 1: Bench" }],
      },
      resolvePreviewTotalPages(sparseManifest, 5),
      true,
      DEFAULT_GLOBAL.book_preview.text_structure,
      DEFAULT_GLOBAL.voice_narration,
    );
    expect(l1.passed).toBe(true);
  });

  it("L4 flags stale MP3 files and missing WebM tracks, and L5 produces 3-persona readiness scorecard", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "audio-qa-l4-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "page-01.mp3"), "stale");
    const l4 = runLayer4MasteringTiming(BASE_MANIFEST, dir, dir, "ffprobe");
    expect(l4.passed).toBe(false);
    expect(l4.failures.some((f) => f.includes("Stale MP3 files present"))).toBe(true);
    expect(l4.failures.some((f) => f.includes("audio file missing on disk"))).toBe(true);

    const cleanLayers = [
      { layer: "L1_TEXT_LEXICON" as const, passed: true, failures: [], warnings: [], metrics: { requiredLandmarks: 2, presentLandmarks: 2 } },
      { layer: "L2_THESIS_GAP" as const, passed: true, failures: [], warnings: [], metrics: {} },
      { layer: "L3_ACOUSTIC_F0" as const, passed: true, failures: [], warnings: [], metrics: { maxOnsetPeakHz: 132.6 } },
      { layer: "L4_MASTERING_TIMING" as const, passed: true, failures: [], warnings: [], metrics: {} },
    ];
    const l5 = runLayer5PersonaScorecard(BASE_MANIFEST, cleanLayers);
    expect(l5.personas).toHaveLength(3);
    expect(l5.layer.metrics.landmarkClarityPct).toBe(100);
  });
});
