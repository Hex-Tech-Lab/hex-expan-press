import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";
import {
  acquireNarrationLock,
  applyNarrationLexicon,
  assemblePagePcm,
  buildChunkDecodeFilter,
  dedupeChunksByCachePath,
  formatChunkForSpeech,
  isMetadataBookPage,
  isValidWavFile,
  parsePageSelection,
  replaceWholeTermInsensitive,
  resolveVoiceFromNarrationSettings,
  synthesizeVcpChunk,
  trimSilencePcm,
} from "../narrate_book_preview";

function makeValidWavBuffer(payloadSize = 16): Buffer {
  const buf = Buffer.alloc(44 + payloadSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + payloadSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(payloadSize, 40);
  return buf;
}

describe("narrate_book_preview helpers", () => {
  it("normalizes sparse cover, metadata, tracked headings, and back cover details without altering prose pages", () => {
    expect(
      formatChunkForSpeech("ELIAS HARTWELL", "paragraph", { isMetadataPage: true, authorName: "Elias Hartwell" }),
    ).toBe("By Eliyas Hartwell.");
    expect(
      formatChunkForSpeech("EXPANPRESS", "paragraph", { isMetadataPage: true, authorName: "Elias Hartwell" }),
    ).toBe("Expan Press.");
    expect(
      formatChunkForSpeech("EXPANPRESS", "paragraph", {
        isMetadataPage: true,
        authorName: "Elias Hartwell",
        lexicon: [],
      }),
    ).toBe("ExpanPress.");
    expect(formatChunkForSpeech("D E TA I L S", "paragraph", { isMetadataPage: true })).toBe("Details.");
    expect(formatChunkForSpeech("A B O U T T H E A U T H O R", "paragraph", { isMetadataPage: true })).toBe(
      "About the author.",
    );
    expect(formatChunkForSpeech("Trim 6 × 9 in Language English", "paragraph", { isMetadataPage: true })).toBe(
      "Trim: 6 by 9 inches. Language: English.",
    );
    expect(formatChunkForSpeech("ExpanPress | MMXXVI", "paragraph", { isMetadataPage: true })).toBe(
      "Expan Press, 2026.",
    );
    expect(formatChunkForSpeech("Elias Hartwell is a pen name.", "paragraph", { isMetadataPage: true })).toBe(
      "Eliyas Hartwell is a pen name.",
    );
    // Mid-sentence interior paragraph on page 8 of a longer book keeps open syntax without adding a synthetic period
    expect(
      formatChunkForSpeech("If you use a lamp, place it so that its light falls across the work from the side", "paragraph", {
        isMetadataPage: false,
      }),
    ).toBe("If you use a lamp, place it so that its light falls across the work from the side");
  });

  it("applies whole-term narration lexicon without dynamic RegExp and preserves non-matching words", () => {
    expect(replaceWholeTermInsensitive("Elias, Elias's, and Eliasing.", "Elias", "Eliyas")).toBe(
      "Eliyas, Eliyas's, and Eliasing.",
    );
    expect(
      applyNarrationLexicon("Published by ExpanPress and Elias.", DEFAULT_GLOBAL.voice_narration.lexicon),
    ).toBe("Published by Expan Press and Eliyas.");
    expect(buildChunkDecodeFilter({ masterFilter: "highpass=f=80", tempo: 1.16 })).toBe("highpass=f=80,atempo=1.16");
    expect(buildChunkDecodeFilter({ masterFilter: "", tempo: 1.0 })).toBeNull();
  });

  it("derives metadata page roles from extracted blocks and selects male/female presets from settings", () => {
    expect(
      isMetadataBookPage([
        { kind: "heading", level: 3, text: "Contents" },
        { kind: "list-item", text: "1. Setting Up the Bench" },
      ]),
    ).toBe(true);
    expect(
      isMetadataBookPage([
        { kind: "paragraph", text: "A calm, practical start to home woodworking" },
        { kind: "paragraph", text: "D E TA I L S" },
        { kind: "paragraph", text: "Trim 6 × 9 in Language English" },
        { kind: "paragraph", text: "ExpanPress | MMXXVI" },
      ]),
    ).toBe(true);
    expect(
      isMetadataBookPage([
        {
          kind: "paragraph",
          text: "When I retired, my expenses were $2,800 a month and I spent years documenting the real withdrawals alongside long-form commentary across multiple full sentences exceeding any cover card.",
        },
      ]),
    ).toBe(false);

    expect(resolveVoiceFromNarrationSettings(DEFAULT_GLOBAL.voice_narration)).toEqual({
      preset: "male",
      voiceId: "c9f39b88-235b-4c2a-851c-3734ce1203be",
      voiceName: "Walter - Calm documentary narrator",
    });
    expect(resolveVoiceFromNarrationSettings(DEFAULT_GLOBAL.voice_narration, { preset: "female" })).toEqual({
      preset: "female",
      voiceId: "84394fa8-60a1-40d9-9a4e-f86738f6b12c",
      voiceName: "Maya - Upbeat tutorial creator",
    });
    expect(() => resolveVoiceFromNarrationSettings(DEFAULT_GLOBAL.voice_narration, { preset: "robot" })).toThrow();

    expect(Array.from(parsePageSelection("1,3-4", 8))).toEqual([1, 3, 4]);
    expect(() => parsePageSelection("99", 8)).toThrow();
    expect(() => parsePageSelection("   ", 8)).toThrow();
    expect(() => parsePageSelection("abc", 8)).toThrow();
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

  it("assembles page PCM with sample-exact startMs/endMs chunk timings and distinct sentence/paragraph/section gaps", () => {
    const sr = 24000;
    const a = new Int16Array(12000).fill(1000); // 500ms
    const b = new Int16Array(24000).fill(1000); // 1000ms
    const c = new Int16Array(12000).fill(1000); // 500ms
    const d = new Int16Array(12000).fill(1000); // 500ms
    const out = assemblePagePcm(
      [
        { id: "p0-b0-s0", blockIndex: 0, blockKind: "heading", text: "Title", spokenText: "Title.", tokensCharged: 40, pcm: a },
        { id: "p0-b1-s0", blockIndex: 1, blockKind: "paragraph", text: "Sentence one.", spokenText: "Sentence one.", tokensCharged: 40, pcm: a },
        { id: "p0-b1-s1", blockIndex: 1, blockKind: "paragraph", text: "Sentence two.", spokenText: "Sentence two.", tokensCharged: 50, pcm: b },
        { id: "p0-b2-s0", blockIndex: 2, blockKind: "paragraph", text: "Next block.", spokenText: "Next block.", tokensCharged: 35, pcm: c },
        { id: "p0-b3-s0", blockIndex: 3, blockKind: "heading", text: "Section Two", spokenText: "Section Two.", tokensCharged: 30, pcm: d },
      ],
      { sampleRate: sr, pageLeadMs: 100, pageTailMs: 150, sentenceGapMs: 220, paragraphGapMs: 680, sectionGapMs: 1200 },
    );
    expect(out.chunks).toEqual([
      { id: "p0-b0-s0", blockIndex: 0, text: "Title", spokenText: "Title.", tokensCharged: 40, startMs: 100, endMs: 600 },
      { id: "p0-b1-s0", blockIndex: 1, text: "Sentence one.", spokenText: "Sentence one.", tokensCharged: 40, startMs: 1800, endMs: 2300 },
      { id: "p0-b1-s1", blockIndex: 1, text: "Sentence two.", spokenText: "Sentence two.", tokensCharged: 50, startMs: 2520, endMs: 3520 },
      { id: "p0-b2-s0", blockIndex: 2, text: "Next block.", spokenText: "Next block.", tokensCharged: 35, startMs: 4200, endMs: 4700 },
      { id: "p0-b3-s0", blockIndex: 3, text: "Section Two", spokenText: "Section Two.", tokensCharged: 30, startMs: 5900, endMs: 6400 },
    ]);
    expect(out.rawDurationMs).toBe(6550);
  });
});

describe("narrate_book_preview cache integrity, locking, and atomic synthesis", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "narrate-hardening-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates WAV magic headers and rejects missing, truncated, or corrupt cache files", () => {
    const dir = makeTempDir();
    const missing = path.join(dir, "missing.wav");
    const truncated = path.join(dir, "truncated.wav");
    const corrupt = path.join(dir, "corrupt.wav");
    const valid = path.join(dir, "valid.wav");

    writeFileSync(truncated, Buffer.from("RIFF1234WAVE", "ascii"));
    writeFileSync(corrupt, Buffer.alloc(64, 0x41));
    writeFileSync(valid, makeValidWavBuffer());

    expect(isValidWavFile(missing)).toBe(false);
    expect(isValidWavFile(truncated)).toBe(false);
    expect(isValidWavFile(corrupt)).toBe(false);
    expect(isValidWavFile(valid)).toBe(true);
  });

  it("enforces exclusive per-cacheDir locking, cleans up on release, and reclaims dead-PID stale locks", () => {
    const dir = makeTempDir();
    const lock = acquireNarrationLock(dir);
    const lockJson = JSON.parse(readFileSync(lock.lockPath, "utf8")) as { pid: number; startedAt: string };
    expect(lockJson.pid).toBe(process.pid);
    expect(typeof lockJson.startedAt).toBe("string");

    // Live PID lock contention refuses loudly
    expect(() => acquireNarrationLock(dir)).toThrow(/Narration lock already held/);

    // Release cleans up lockfile and permits re-acquisition
    lock.release();
    lock.release(); // idempotent
    const reacquired = acquireNarrationLock(dir);
    reacquired.release();

    // Dead PID stale lock is reclaimed cleanly
    const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect(typeof exited.pid).toBe("number");
    writeFileSync(
      lock.lockPath,
      JSON.stringify({ pid: exited.pid, startedAt: new Date(Date.now() - 60_000).toISOString() }),
      "utf8",
    );
    const reclaimed = acquireNarrationLock(dir);
    const reclaimedJson = JSON.parse(readFileSync(reclaimed.lockPath, "utf8")) as { pid: number };
    expect(reclaimedJson.pid).toBe(process.pid);
    reclaimed.release();
  });

  it("deduplicates pending chunks by WAV cache path while preserving order", () => {
    const chunks = [
      { id: "c1", spokenText: "Hello." },
      { id: "c2", spokenText: "World." },
      { id: "c1", spokenText: "Hello." },
    ];
    const unique = dedupeChunksByCachePath(chunks, (c) => `/cache/${c.id}_${c.spokenText}.wav`);
    expect(unique).toEqual([
      { id: "c1", spokenText: "Hello." },
      { id: "c2", spokenText: "World." },
    ]);
  });

  it("rejects empty or corrupt WAV downloads and writes valid WAV payloads atomically with zero leftover temp files", async () => {
    const dir = makeTempDir();
    const badOut = path.join(dir, "bad.wav");
    const goodOut = path.join(dir, "good.wav");

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/speech")) {
        return new Response(JSON.stringify({ id: "job-1" }), { status: 200 });
      }
      if (url.includes("/v1/jobs/")) {
        return new Response(
          JSON.stringify({
            status: "succeeded",
            tokens_charged: 12,
            result: { audio_url: "https://cdn.vcp.test/out.wav" },
          }),
          { status: 200 },
        );
      }
      return new Response(Buffer.from("not-a-wav"), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      synthesizeVcpChunk("https://api.vcp.test", "k", "v", "m", "Hi", badOut, {
        poll_wait_seconds: 1,
        max_poll_attempts: 1,
        request_timeout_ms: 5000,
      }),
    ).rejects.toThrow(/not a valid WAV payload/);
    expect(isValidWavFile(badOut)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);

    const validWav = makeValidWavBuffer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/speech")) {
          return new Response(JSON.stringify({ id: "job-2" }), { status: 200 });
        }
        if (url.includes("/v1/jobs/")) {
          return new Response(
            JSON.stringify({
              status: "succeeded",
              tokens_charged: 18,
              result: { audio_url: "https://cdn.vcp.test/good.wav" },
            }),
            { status: 200 },
          );
        }
        return new Response(new Uint8Array(validWav), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      }),
    );

    const result = await synthesizeVcpChunk("https://api.vcp.test", "k", "v", "m", "Hi", goodOut, {
      poll_wait_seconds: 1,
      max_poll_attempts: 1,
      request_timeout_ms: 5000,
    });
    expect(result).toEqual({ billedUnits: 18 });
    expect(isValidWavFile(goodOut)).toBe(true);
    expect(readdirSync(dir)).toEqual(["good.wav"]);
  });
});
