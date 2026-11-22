// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL, type BookPreviewReadAloudSettings } from "../../payments/src/settings_registry";
import type { PreviewAudioManifest, ReadAloudChunk } from "../src/components/storefront/book-previewer-text";
import { parsePreviewAudioManifest } from "../src/components/storefront/read-aloud-audio";
import { useReadAloud } from "../src/components/storefront/use-read-aloud";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useReadAloud>;

const spreadChunks: ReadAloudChunk[] = [
  { id: "p1-b0-s0", pageIndex: 1, blockIndex: 0, text: "The Quiet Workshop" },
  { id: "p1-b1-s0", pageIndex: 1, blockIndex: 1, text: "Sample: Chapter 1 of 12" },
  { id: "p2-b0-s0", pageIndex: 2, blockIndex: 0, text: "Contents" },
  { id: "p2-b1-s0", pageIndex: 2, blockIndex: 1, text: "1. Setting Up the Bench." },
];

const nextSpreadChunks: ReadAloudChunk[] = [
  { id: "p3-b0-s0", pageIndex: 3, blockIndex: 0, text: "Chapter 1: Setting Up the Bench" },
];

const SAMPLE_MANIFEST: PreviewAudioManifest = {
  version: 1,
  bookId: "sample_the_quiet_workshop",
  voiceId: "c9f39b88-235b-4c2a-851c-3734ce1203be",
  voiceName: "Walter - Calm documentary narrator",
  model: "qwen3-tts",
  sampleRateHz: 44100,
  loudnormLufs: -16,
  generatedAt: "2026-11-22T15:00:00.000Z",
  pages: {
    "2": {
      pageIndex: 1,
      pdfPageNumber: 2,
      audioUrl: "/books/audio/sample_the_quiet_workshop/page-02.mp3",
      opusUrl: "/books/audio/sample_the_quiet_workshop/page-02.webm",
      durationMs: 4200,
      chunks: [
        { id: "p1-b0-s0", blockIndex: 0, text: "The Quiet Workshop", startMs: 120, endMs: 1800 },
        { id: "p1-b1-s0", blockIndex: 1, text: "Sample: Chapter 1 of 12", startMs: 2220, endMs: 4000 },
      ],
    },
    "3": {
      pageIndex: 2,
      pdfPageNumber: 3,
      audioUrl: "/books/audio/sample_the_quiet_workshop/page-03.mp3",
      opusUrl: "/books/audio/sample_the_quiet_workshop/page-03.webm",
      durationMs: 5000,
      chunks: [
        { id: "p2-b0-s0", blockIndex: 0, text: "Contents", startMs: 120, endMs: 1200 },
        { id: "p2-b1-s0", blockIndex: 1, text: "1. Setting Up the Bench.", startMs: 1620, endMs: 4800 },
      ],
    },
    "4": {
      pageIndex: 3,
      pdfPageNumber: 4,
      audioUrl: "/books/audio/sample_the_quiet_workshop/page-04.mp3",
      opusUrl: "/books/audio/sample_the_quiet_workshop/page-04.webm",
      durationMs: 3000,
      chunks: [{ id: "p3-b0-s0", blockIndex: 0, text: "Chapter 1: Setting Up the Bench", startMs: 120, endMs: 2800 }],
    },
  },
};

class MockAudioElement {
  static instances: MockAudioElement[] = [];
  static nextCanPlayOpus = "probably";
  src = "";
  preload = "";
  currentTime = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = true;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;
  srcHistory: string[] = [];
  playShouldReject: Error | null = null;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    MockAudioElement.instances.push(this);
  }
  canPlayType = vi.fn((mimeType: string) => (mimeType.includes("opus") ? MockAudioElement.nextCanPlayOpus : ""));
  load = vi.fn();
  removeAttribute(attr: string) {
    if (attr === "src") this.src = "";
  }
  play = vi.fn(() => {
    this.playCalls += 1;
    this.srcHistory.push(this.src);
    if (this.playShouldReject) {
      return Promise.reject(this.playShouldReject);
    }
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.pauseCalls += 1;
    this.paused = true;
  });
}

describe("useReadAloud pre-baked audio manifest + timings sync + Web Speech fallback", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: Hook;
  let onExpand: ReturnType<typeof vi.fn>;
  let currentChunks: ReadAloudChunk[] = spreadChunks;
  let currentManifestUrl: string | null = "/books/audio/sample_the_quiet_workshop/timings.json";
  let currentAudioBasePath = "/books/audio";
  let currentSettings: BookPreviewReadAloudSettings = DEFAULT_GLOBAL.book_preview.read_aloud;

  function Harness() {
    latest = useReadAloud(
      currentChunks,
      currentSettings,
      () => onExpand(),
      currentManifestUrl,
      currentAudioBasePath,
    );
    return null;
  }

  async function mount(manifestOk = true, manifestOverride: PreviewAudioManifest = SAMPLE_MANIFEST) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        manifestOk
          ? new Response(JSON.stringify(manifestOverride), { status: 200, headers: { "Content-Type": "application/json" } })
          : new Response("Not Found", { status: 404 }),
      ),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  beforeEach(() => {
    MockAudioElement.instances = [];
    MockAudioElement.nextCanPlayOpus = "probably";
    currentChunks = spreadChunks;
    currentManifestUrl = "/books/audio/sample_the_quiet_workshop/timings.json";
    currentAudioBasePath = "/books/audio";
    currentSettings = DEFAULT_GLOBAL.book_preview.read_aloud;
    onExpand = vi.fn();
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
    vi.stubGlobal("Audio", MockAudioElement);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("plays pre-baked MP3 across a 2-page spread with preservesPitch=true, no speechSynthesis required, and syncs chunks via timeupdate", async () => {
    await mount(true);
    expect(latest.speechSupported).toBe(false);
    expect(latest.audioSupported).toBe(true);
    expect(latest.readAloudSupported).toBe(true);

    await act(async () => latest.handlePlayPauseResume());
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(latest.playbackState).toBe("playing");
    expect(latest.activeChunkId).toBe("p1-b0-s0");

    const audio = MockAudioElement.instances[0];
    expect(audio.preload).toBe("none");
    expect(audio.src).toBe("/books/audio/sample_the_quiet_workshop/page-02.webm");
    expect(audio.preservesPitch).toBe(true);
    expect(audio.playbackRate).toBe(1);

    // Mid-playback timeupdate during breath gap (2.0s) keeps chunk 0 lit; 2.3s advances to chunk 1
    await act(async () => {
      audio.currentTime = 2.0;
      audio.ontimeupdate?.();
    });
    expect(latest.activeChunkId).toBe("p1-b0-s0");

    await act(async () => {
      audio.currentTime = 2.3;
      audio.ontimeupdate?.();
    });
    expect(latest.activeChunkId).toBe("p1-b1-s0");

    // Mid-playback speed switch changes playbackRate smoothly without restarting or re-calling play()
    const playCallsBeforeSpeed = audio.playCalls;
    await act(async () => latest.handleCycleSpeed());
    expect(latest.currentRate).toBe(1.25);
    expect(audio.playbackRate).toBe(1.25);
    expect(audio.defaultPlaybackRate).toBe(1.25);
    expect(audio.preservesPitch).toBe(true);
    expect(audio.playCalls).toBe(playCallsBeforeSpeed);

    // Page 2 ends -> seamlessly plays Page 3 at the same 1.25x rate with preservesPitch=true
    await act(async () => {
      audio.onended?.();
    });
    expect(latest.playbackState).toBe("playing");
    expect(audio.src).toBe("/books/audio/sample_the_quiet_workshop/page-03.webm");
    expect(audio.playbackRate).toBe(1.25);
    expect(audio.preservesPitch).toBe(true);
    expect(latest.activeChunkId).toBe("p2-b0-s0");

    await act(async () => {
      audio.currentTime = 2.1;
      audio.ontimeupdate?.();
    });
    expect(latest.activeChunkId).toBe("p2-b1-s0");

    // Page 3 ends -> spread completes cleanly
    await act(async () => {
      audio.onended?.();
    });
    expect(latest.playbackState).toBe("idle");
    expect(latest.activeChunkId).toBeNull();
    expect(latest.speechAnnouncement).toBe(DEFAULT_GLOBAL.book_preview.read_aloud.labels.finished_announcement);
  });

  it("pauses, applies speed change while paused, resumes from same timestamp, and follows page turns", async () => {
    await mount(true);
    await act(async () => latest.handlePlayPauseResume());
    const audio = MockAudioElement.instances[0];
    audio.currentTime = 2.5;

    await act(async () => latest.handlePlayPauseResume());
    expect(latest.playbackState).toBe("paused");
    expect(audio.pauseCalls).toBe(1);

    await act(async () => latest.handleCycleSpeed());
    expect(latest.currentRate).toBe(1.25);
    expect(audio.playbackRate).toBe(1.25);

    await act(async () => latest.handlePlayPauseResume());
    expect(latest.playbackState).toBe("playing");
    expect(audio.currentTime).toBe(2.5);
    expect(audio.playbackRate).toBe(1.25);

    // Page turn during playback switches immediately to page-04.webm at 1.25x
    currentChunks = nextSpreadChunks;
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    expect(audio.src).toBe("/books/audio/sample_the_quiet_workshop/page-04.webm");
    expect(audio.playbackRate).toBe(1.25);
    expect(latest.activeChunkId).toBe("p3-b0-s0");
  });

  it("falls back transparently to Web Speech when timings.json fails or <audio> errors", async () => {
    const speak = vi.fn();
    class FakeUtterance {
      text: string;
      rate = 1;
      constructor(text: string) {
        this.text = text;
      }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });
    Object.defineProperty(window, "speechSynthesis", {
      value: { paused: false, speaking: false, pending: false, speak, cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: () => [] },
      configurable: true,
    });

    await mount(false);
    expect(latest.audioSupported).toBe(false);
    expect(latest.readAloudSupported).toBe(true);

    await act(async () => latest.handlePlayPauseResume());
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0][0] as FakeUtterance).text).toBe(spreadChunks[0].text);
    expect(MockAudioElement.instances).toHaveLength(0);
  });

  it("keeps preload=none until Play, falls back from Opus webm decode error to MP3 before Web Speech, and selects MP3 directly when Opus is unsupported", async () => {
    const speak = vi.fn();
    class FakeUtterance {
      text: string;
      rate = 1;
      constructor(text: string) {
        this.text = text;
      }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });
    Object.defineProperty(window, "speechSynthesis", {
      value: { paused: false, speaking: false, pending: false, speak, cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: () => [] },
      configurable: true,
    });

    // (a) Zero Audio elements constructed on mount (timings.json pre-fetched, preload="none" until Play tap)
    await mount(true);
    expect(MockAudioElement.instances).toHaveLength(0);

    // (b) Opus-capable browser selects .webm first with preload="none"; .webm error switches cleanly to .mp3 without Web Speech
    await act(async () => latest.handlePlayPauseResume());
    expect(MockAudioElement.instances).toHaveLength(1);
    const audio = MockAudioElement.instances[0];
    expect(audio.preload).toBe("none");
    expect(audio.src).toBe("/books/audio/sample_the_quiet_workshop/page-02.webm");
    expect(speak).not.toHaveBeenCalled();

    await act(async () => {
      audio.onerror?.();
    });
    expect(speak).not.toHaveBeenCalled();
    expect(audio.src).toBe("/books/audio/sample_the_quiet_workshop/page-02.mp3");
    expect(audio.srcHistory).toEqual([
      "/books/audio/sample_the_quiet_workshop/page-02.webm",
      "/books/audio/sample_the_quiet_workshop/page-02.mp3",
    ]);

    // (c) Web Speech triggers only when the .mp3 fallback also errors
    await act(async () => {
      audio.onerror?.();
    });
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0][0] as FakeUtterance).text).toBe(spreadChunks[0].text);

    await act(async () => {
      root.unmount();
    });
    container.remove();

    // (d) Safari/iOS (canPlayType === "") selects .mp3 directly without requesting .webm
    MockAudioElement.instances = [];
    MockAudioElement.nextCanPlayOpus = "";
    await mount(true);
    await act(async () => latest.handlePlayPauseResume());
    expect(MockAudioElement.instances).toHaveLength(1);
    const safariAudio = MockAudioElement.instances[0];
    expect(safariAudio.canPlayType).toHaveBeenCalledWith('audio/webm; codecs="opus"');
    expect(safariAudio.src).toBe("/books/audio/sample_the_quiet_workshop/page-02.mp3");
    expect(safariAudio.srcHistory).toEqual(["/books/audio/sample_the_quiet_workshop/page-02.mp3"]);
  });

  it("supports custom audioBasePath, rejects stale manifests with mismatched text, and updates activeWord when highlight_words=true", async () => {
    // 1) Custom audioBasePath accepts matching track URLs and ignores mismatched prefixes
    currentAudioBasePath = "/books/audio_v2";
    currentManifestUrl = "/books/audio_v2/sample/timings.json";
    const customManifest: PreviewAudioManifest = {
      ...SAMPLE_MANIFEST,
      pages: {
        ...SAMPLE_MANIFEST.pages,
        "2": {
          ...SAMPLE_MANIFEST.pages["2"],
          audioUrl: "/books/audio_v2/sample/page-02.mp3",
          opusUrl: "/books/audio_v2/sample/page-02.webm",
        },
        "3": {
          ...SAMPLE_MANIFEST.pages["3"],
          audioUrl: "/books/audio_v2/sample/page-03.mp3",
          opusUrl: "/books/audio_v2/sample/page-03.webm",
        },
      },
    };
    await mount(true, customManifest);
    expect(latest.audioSupported).toBe(true);
    await root.unmount();
    container.remove();

    // Default prefix inside customBasePath is rejected
    await mount(true, SAMPLE_MANIFEST);
    expect(latest.audioSupported).toBe(false);
    await root.unmount();
    container.remove();

    // 2) Stale manifest matching IDs/blockIndex but different text is rejected
    currentAudioBasePath = "/books/audio";
    currentManifestUrl = "/books/audio/sample_the_quiet_workshop/timings.json";
    const staleManifest: PreviewAudioManifest = {
      ...SAMPLE_MANIFEST,
      pages: {
        ...SAMPLE_MANIFEST.pages,
        "2": {
          ...SAMPLE_MANIFEST.pages["2"],
          chunks: [
            { id: "p1-b0-s0", blockIndex: 0, text: "Stale outdated title", startMs: 120, endMs: 1800 },
            SAMPLE_MANIFEST.pages["2"].chunks[1],
          ],
        },
      },
    };
    await mount(true, staleManifest);
    expect(latest.audioSupported).toBe(false);
    await root.unmount();
    container.remove();

    // 3) highlight_words=true drives activeWord during timeupdate and stays null in silence gaps
    currentSettings = { ...DEFAULT_GLOBAL.book_preview.read_aloud, highlight_words: true };
    await mount(true, SAMPLE_MANIFEST);
    await act(async () => latest.handlePlayPauseResume());
    const audio = MockAudioElement.instances[0];
    expect(latest.activeWord).toBeNull();

    await act(async () => {
      audio.currentTime = 0.2; // 200ms -> "The"
      audio.ontimeupdate?.();
    });
    expect(latest.activeWord).toEqual({ chunkId: "p1-b0-s0", start: 0, end: 3 });

    await act(async () => {
      audio.currentTime = 1.5; // 1500ms -> "Workshop"
      audio.ontimeupdate?.();
    });
    expect(latest.activeWord).toEqual({ chunkId: "p1-b0-s0", start: 10, end: 18 });

    await act(async () => {
      audio.currentTime = 2.0; // silence gap between chunks -> cleared
      audio.ontimeupdate?.();
    });
    expect(latest.activeWord).toBeNull();
  });

  it("resumes Web Speech fallback from the active mid-page chunk rather than chunk 0 when audio.onerror fires (F-01)", async () => {
    const speak = vi.fn();
    class FakeUtterance {
      text: string;
      rate = 1;
      constructor(text: string) {
        this.text = text;
      }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });
    Object.defineProperty(window, "speechSynthesis", {
      value: { paused: false, speaking: false, pending: false, speak, cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: () => [] },
      configurable: true,
    });

    currentChunks = [
      { id: "p1-b0-s0", pageIndex: 1, blockIndex: 0, text: "First chunk on page." },
      { id: "p1-b1-s0", pageIndex: 1, blockIndex: 1, text: "Second chunk on page." },
      { id: "p1-b2-s0", pageIndex: 1, blockIndex: 2, text: "Third chunk on page." },
    ];
    const threeChunkManifest: PreviewAudioManifest = {
      ...SAMPLE_MANIFEST,
      pages: {
        "2": {
          pageIndex: 1,
          pdfPageNumber: 2,
          audioUrl: "/books/audio/sample_the_quiet_workshop/page-02.mp3",
          durationMs: 6000,
          chunks: [
            { id: "p1-b0-s0", blockIndex: 0, text: "First chunk on page.", startMs: 100, endMs: 1500 },
            { id: "p1-b1-s0", blockIndex: 1, text: "Second chunk on page.", startMs: 1700, endMs: 3500 },
            { id: "p1-b2-s0", blockIndex: 2, text: "Third chunk on page.", startMs: 3700, endMs: 5800 },
          ],
        },
      },
    };

    await mount(true, threeChunkManifest);
    await act(async () => latest.handlePlayPauseResume());
    const audio = MockAudioElement.instances[0];
    expect(latest.activeChunkId).toBe("p1-b0-s0");

    await act(async () => {
      audio.currentTime = 4.0;
      audio.ontimeupdate?.();
    });
    expect(latest.activeChunkId).toBe("p1-b2-s0");

    await act(async () => {
      audio.onerror?.();
    });
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0][0] as FakeUtterance).text).toBe("Third chunk on page.");
    expect(latest.activeChunkId).toBe("p1-b2-s0");
  });

  it("rejects corrupt timing manifests (negative startMs, endMs <= startMs, durationMs <= 0, duplicate chunk ids, malformed words)", () => {
    const basePage = SAMPLE_MANIFEST.pages["2"];
    const withPage2 = (override: Record<string, unknown>) => ({
      ...SAMPLE_MANIFEST,
      pages: { "2": { ...basePage, ...override } },
    });

    expect(
      parsePreviewAudioManifest(
        withPage2({
          chunks: [{ id: "p1-b0-s0", blockIndex: 0, text: "Negative start", startMs: -10, endMs: 500 }],
        }),
      ),
    ).toBeNull();

    expect(
      parsePreviewAudioManifest(
        withPage2({
          chunks: [{ id: "p1-b0-s0", blockIndex: 0, text: "Zero span", startMs: 500, endMs: 500 }],
        }),
      ),
    ).toBeNull();

    expect(
      parsePreviewAudioManifest(
        withPage2({
          chunks: [{ id: "p1-b0-s0", blockIndex: 0, text: "Inverted span", startMs: 800, endMs: 400 }],
        }),
      ),
    ).toBeNull();

    expect(parsePreviewAudioManifest(withPage2({ durationMs: 0 }))).toBeNull();
    expect(parsePreviewAudioManifest(withPage2({ durationMs: -1200 }))).toBeNull();

    expect(
      parsePreviewAudioManifest(
        withPage2({
          chunks: [
            { id: "p1-b0-s0", blockIndex: 0, text: "Chunk A", startMs: 100, endMs: 800 },
            { id: "p1-b0-s0", blockIndex: 1, text: "Duplicate ID", startMs: 900, endMs: 1500 },
          ],
        }),
      ),
    ).toBeNull();

    const parsedWithBadWords = parsePreviewAudioManifest(
      withPage2({
        chunks: [
          {
            id: "p1-b0-s0",
            blockIndex: 0,
            text: "Hello world",
            startMs: 100,
            endMs: 1000,
            words: [
              { start: 0, end: 5, startMs: -5, endMs: 300 },
              { start: 0, end: 5, startMs: 300, endMs: 300 },
              { start: 6, end: 11, startMs: 400, endMs: 900 },
            ],
          },
        ],
      }),
    );
    expect(parsedWithBadWords).not.toBeNull();
    expect(parsedWithBadWords?.pages["2"].chunks[0].words).toEqual([
      { start: 6, end: 11, startMs: 400, endMs: 900 },
    ]);
  });
});
