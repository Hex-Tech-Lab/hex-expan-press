// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";
import type { PreviewAudioManifest, ReadAloudChunk } from "../src/components/storefront/book-previewer-text";
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
      durationMs: 3000,
      chunks: [{ id: "p3-b0-s0", blockIndex: 0, text: "Chapter 1: Setting Up the Bench", startMs: 120, endMs: 2800 }],
    },
  },
};

class MockAudioElement {
  static instances: MockAudioElement[] = [];
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

  function Harness() {
    latest = useReadAloud(
      currentChunks,
      DEFAULT_GLOBAL.book_preview.read_aloud,
      () => onExpand(),
      currentManifestUrl,
    );
    return null;
  }

  async function mount(manifestOk = true) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        manifestOk
          ? new Response(JSON.stringify(SAMPLE_MANIFEST), { status: 200, headers: { "Content-Type": "application/json" } })
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
    currentChunks = spreadChunks;
    currentManifestUrl = "/books/audio/sample_the_quiet_workshop/timings.json";
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
    expect(audio.src).toBe("/books/audio/sample_the_quiet_workshop/page-02.mp3");
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
    expect(audio.src).toBe("/books/audio/sample_the_quiet_workshop/page-03.mp3");
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

    // Page turn during playback switches immediately to page-04.mp3 at 1.25x
    currentChunks = nextSpreadChunks;
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    expect(audio.src).toBe("/books/audio/sample_the_quiet_workshop/page-04.mp3");
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

  it("falls back to Web Speech if pre-baked MP3 playback errors mid-flight", async () => {
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

    await mount(true);
    await act(async () => latest.handlePlayPauseResume());
    const audio = MockAudioElement.instances[0];
    expect(speak).not.toHaveBeenCalled();

    await act(async () => {
      audio.onerror?.();
    });
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0][0] as FakeUtterance).text).toBe(spreadChunks[0].text);
  });
});
