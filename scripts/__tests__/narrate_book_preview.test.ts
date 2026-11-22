import { describe, expect, it } from "vitest";
import { assemblePagePcm, formatChunkForSpeech, trimSilencePcm } from "../narrate_book_preview";

describe("narrate_book_preview helpers", () => {
  it("normalizes sparse cover, metadata, tracked headings, and back cover details naturally", () => {
    expect(formatChunkForSpeech("ELIAS HARTWELL", "paragraph", 0, "Elias Hartwell")).toBe("By Elias Hartwell.");
    expect(formatChunkForSpeech("EXPANPRESS", "paragraph", 0, "Elias Hartwell")).toBe("ExpanPress.");
    expect(formatChunkForSpeech("D E TA I L S", "paragraph", 7)).toBe("Details.");
    expect(formatChunkForSpeech("A B O U T T H E A U T H O R", "paragraph", 7)).toBe("About the author.");
    expect(formatChunkForSpeech("Trim 6 × 9 in Language English", "paragraph", 7)).toBe(
      "Trim: 6 by 9 inches. Language: English.",
    );
    expect(formatChunkForSpeech("ExpanPress | MMXXVI", "paragraph", 7)).toBe("ExpanPress, 2026.");
    // Mid-sentence interior paragraph on page 5 keeps open syntax without adding a synthetic period
    expect(formatChunkForSpeech("If you use a lamp, place it so that its light falls across the work from the side", "paragraph", 4)).toBe(
      "If you use a lamp, place it so that its light falls across the work from the side",
    );
  });

  it("trims leading/trailing silence while retaining pad margins and soft fade", () => {
    const sr = 24000;
    const pcm = new Int16Array(sr); // 1 second
    // Active signal only between 0.30s and 0.60s
    for (let i = 7200; i < 14400; i++) pcm[i] = 5000;

    const trimmed = trimSilencePcm(pcm, sr, { thresholdDb: -46, padStartMs: 40, padEndMs: 60, fadeMs: 10 });
    // Expected span: [7200 - 960, 14399 + 1440) = 9599 samples (~400ms)
    expect(trimmed.length).toBe(9599);
    expect(trimmed[0]).toBe(0);
    expect(trimmed[trimmed.length - 1]).toBe(0);
    expect(Math.abs(trimmed[1200])).toBe(5000);
  });

  it("assembles page PCM with sample-exact startMs/endMs chunk timings and distinct sentence/paragraph gaps", () => {
    const sr = 24000;
    const a = new Int16Array(12000).fill(1000); // 500ms
    const b = new Int16Array(24000).fill(1000); // 1000ms
    const c = new Int16Array(12000).fill(1000); // 500ms
    const out = assemblePagePcm(
      [
        { id: "p0-b0-s0", blockIndex: 0, text: "Sentence one.", spokenText: "Sentence one.", tokensCharged: 40, pcm: a },
        { id: "p0-b0-s1", blockIndex: 0, text: "Sentence two.", spokenText: "Sentence two.", tokensCharged: 50, pcm: b },
        { id: "p0-b1-s0", blockIndex: 1, text: "Next block.", spokenText: "Next block.", tokensCharged: 35, pcm: c },
      ],
      { sampleRate: sr, pageLeadMs: 100, pageTailMs: 150, sentenceGapMs: 250, paragraphGapMs: 450 },
    );
    expect(out.chunks).toEqual([
      { id: "p0-b0-s0", blockIndex: 0, text: "Sentence one.", spokenText: "Sentence one.", tokensCharged: 40, startMs: 100, endMs: 600 },
      { id: "p0-b0-s1", blockIndex: 0, text: "Sentence two.", spokenText: "Sentence two.", tokensCharged: 50, startMs: 850, endMs: 1850 },
      { id: "p0-b1-s0", blockIndex: 1, text: "Next block.", spokenText: "Next block.", tokensCharged: 35, startMs: 2300, endMs: 2800 },
    ]);
    expect(out.rawDurationMs).toBe(2950);
  });
});
