// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";
import type { PreviewAudioManifest, PreviewAudioPageTrack } from "../src/components/storefront/read-aloud-audio";
import type { ReadAloudChunk } from "../src/components/storefront/book-previewer-text";
import { runPrebakedTrackQueue } from "../src/components/storefront/read-aloud-engines";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flipMocks = vi.hoisted(() => ({
  orientation: "landscape" as "portrait" | "landscape",
  instances: [] as Array<{
    handlers: Record<string, (e: { data: unknown }) => void>;
    flipNext: ReturnType<typeof vi.fn>;
    turnToPage: ReturnType<typeof vi.fn>;
    currentPage: number;
    emitOrientation: (next: "portrait" | "landscape") => void;
  }>,
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 6,
      getPage: async (n: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 600 * scale }),
        render: () => ({ promise: Promise.resolve() }),
        getTextContent: async () => ({
          items: [
            { str: `Chapter ${n}`, hasEOL: true, height: 22, transform: [22, 0, 0, 22, 24, 520] },
            { str: `First sentence on page ${n}. Second sentence on page ${n}.`, hasEOL: true, height: 10, transform: [10, 0, 0, 10, 24, 480] },
          ],
        }),
      }),
    }),
  }),
}));

vi.mock("page-flip", () => {
  class MockPageFlip {
    private state: (typeof flipMocks.instances)[number];
    constructor() {
      const state: (typeof flipMocks.instances)[number] = {
        handlers: {},
        currentPage: 0,
        flipNext: vi.fn(() => {
          state.currentPage = Math.min(state.currentPage + (flipMocks.orientation === "landscape" && state.currentPage > 0 ? 2 : 1), 5);
          state.handlers.flip?.({ data: state.currentPage });
        }),
        turnToPage: vi.fn((p: number) => {
          state.currentPage = p;
          state.handlers.flip?.({ data: p });
        }),
        emitOrientation: (next: "portrait" | "landscape") => {
          flipMocks.orientation = next;
          state.handlers.changeOrientation?.({ data: next });
        },
      };
      this.state = state;
      flipMocks.instances.push(state);
    }
    on(event: string, cb: (e: { data: unknown }) => void) {
      this.state.handlers[event] = cb;
    }
    loadFromImages() {
      this.state.handlers.init?.({ data: { page: 0, mode: flipMocks.orientation } });
    }
    getOrientation() {
      return flipMocks.orientation;
    }
    getCurrentPageIndex() {
      return this.state.currentPage;
    }
    flipNext() {
      this.state.flipNext();
    }
    turnToPage(p: number) {
      this.state.turnToPage(p);
    }
    destroy() {}
    getUI() {
      return { update: vi.fn() };
    }
  }
  return { PageFlip: MockPageFlip };
});

import BookPreviewer from "../src/components/storefront/book-previewer";

class MockAudioElement {
  static instances: MockAudioElement[] = [];
  src = "";
  preload = "";
  readyState = 0;
  currentTime = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = true;
  paused = true;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    MockAudioElement.instances.push(this);
  }
  canPlayType = vi.fn((m: string) => (m.includes("opus") || m.includes("mpeg") ? "probably" : ""));
  load = vi.fn();
  removeAttribute(attr: string) {
    if (attr === "src") this.src = "";
  }
  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
}

const MANIFEST: PreviewAudioManifest = {
  version: 1,
  bookId: "test_book",
  voiceId: "v1",
  voiceName: "Walter",
  voiceGender: "male",
  model: "qwen3-tts",
  sampleRateHz: 48000,
  loudnormLufs: -16,
  generatedAt: "2026-11-23T00:00:00.000Z",
  pages: {
    "2": {
      pageIndex: 1,
      pdfPageNumber: 2,
      audioUrl: "/books/audio/test_book/page-02.webm",
      durationMs: 4000,
      chunks: [
        { id: "p1-b0-s0", blockIndex: 0, text: "Chapter 2", startMs: 120, endMs: 1100 },
        { id: "p1-b1-s0", blockIndex: 1, text: "First sentence on page 2.", startMs: 1320, endMs: 2500 },
        { id: "p1-b1-s1", blockIndex: 1, text: "Second sentence on page 2.", startMs: 2720, endMs: 3900 },
      ],
    },
    "3": {
      pageIndex: 2,
      pdfPageNumber: 3,
      audioUrl: "/books/audio/test_book/page-03.webm",
      durationMs: 4000,
      chunks: [
        { id: "p2-b0-s0", blockIndex: 0, text: "Chapter 3", startMs: 120, endMs: 1100 },
        { id: "p2-b1-s0", blockIndex: 1, text: "First sentence on page 3.", startMs: 1320, endMs: 2500 },
        { id: "p2-b1-s1", blockIndex: 1, text: "Second sentence on page 3.", startMs: 2720, endMs: 3900 },
      ],
    },
  },
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("PR #162 CodeRabbit regressions for Read-Aloud engine and orientation continuity", () => {
  beforeEach(() => {
    flipMocks.orientation = "landscape";
    flipMocks.instances = [];
    MockAudioElement.instances = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => "data:image/png;base64,stub");
    vi.stubGlobal("Audio", MockAudioElement);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
  });

  afterEach(async () => {
    if (root) {
      await act(async () => { root!.unmount(); });
      root = null;
    }
    container?.remove();
    container = null;
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("syncs active chunk page on landscape->portrait change and rebinds portrait->landscape track callbacks", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(BookPreviewer, {
          previewPdfUrl: "/books/previews/test.pdf",
          previewAudioManifestUrl: "/books/audio/test_book/timings.json",
          bookTitle: "Test Book",
          settings: DEFAULT_GLOBAL.book_preview,
        }),
      );
    });
    await flush();
    await flush();

    // Flip to landscape Pages 2-3 (pageIndex=1), click sentence on Page 3 (pageIndex=2)
    await act(async () => {
      (container!.querySelector('button[aria-label="Next preview page"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container!.querySelector('[data-testid="book-preview-accessible-toggle"]') as HTMLButtonElement).click();
    });
    const page3Sentence = container.querySelector('[data-testid="read-aloud-sentence"][data-chunk-id="p2-b1-s0"]') as HTMLElement;
    await act(async () => page3Sentence.click());

    // PRRT_kwDOUrokqs665SeV: rotating to portrait keeps Page 3 (not Page 2) and stays on p2-b1-s0
    const inst = flipMocks.instances[0];
    await act(async () => inst.emitOrientation("portrait"));
    await flush();
    expect(container.querySelector('[data-testid="book-preview-page-label"]')?.textContent).toBe("Page 3 of 6");
    expect(container.querySelector('[data-testid="read-aloud-sentence"][data-chunk-id="p2-b1-s0"]')?.getAttribute("data-active")).toBe("true");

    // PRRT_kwDOUrokqs665Se4: switch to Page 2 in portrait, rotate back to landscape [2,3], finish Page 2 -> plays Page 3
    await act(async () => inst.turnToPage(1));
    await flush();
    const audio = MockAudioElement.instances[0];
    audio.readyState = 4;
    await act(async () => inst.emitOrientation("landscape"));
    await flush();
    expect(container.querySelector('[data-testid="book-preview-page-label"]')?.textContent).toBe("Pages 2–3 of 6");
    await act(async () => audio.onended?.());
    expect(audio.src).toBe("/books/audio/test_book/page-03.webm");
  });

  it("invalidates stale paused Web Speech sequence on portrait->landscape change so Resume reads full spread", async () => {
    flipMocks.orientation = "portrait";
    const utterances: Array<{ text: string; onend: (() => void) | null }> = [];
    const speak = vi.fn();
    const cancel = vi.fn();
    const pause = vi.fn(() => { synthState.paused = true; synthState.speaking = false; });
    const resume = vi.fn();
    const synthState = {
      paused: false,
      speaking: false,
      pending: false,
      speak: (u: { text: string; onend: (() => void) | null }) => { synthState.speaking = true; speak(u); },
      cancel: () => { synthState.paused = false; synthState.speaking = false; cancel(); },
      pause,
      resume,
      getVoices: () => [],
    };
    class FakeUtterance {
      text: string;
      rate = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
        utterances.push(this);
      }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });
    Object.defineProperty(window, "speechSynthesis", { value: synthState, configurable: true });
    vi.stubGlobal("Audio", undefined);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(BookPreviewer, {
          previewPdfUrl: "/books/previews/test.pdf",
          bookTitle: "Test Book",
          settings: DEFAULT_GLOBAL.book_preview,
        }),
      );
    });
    await flush();
    await flush();

    const inst = flipMocks.instances[0];
    await act(async () => inst.turnToPage(1));
    await flush();
    const playToggle = container.querySelector('[data-testid="read-aloud-toggle"]') as HTMLButtonElement;
    await act(async () => playToggle.click()); // play Page 2
    await act(async () => playToggle.click()); // pause on Page 2
    expect(playToggle.getAttribute("data-playback-state")).toBe("paused");

    // PRRT_kwDOUrokqs665SfE: rotate to landscape [Page 2, Page 3] while paused -> cancels stale session, Resume plays full spread
    await act(async () => inst.emitOrientation("landscape"));
    await flush();
    expect(cancel).toHaveBeenCalled();

    const beforeCount = utterances.length;
    await act(async () => playToggle.click()); // resume
    expect(resume).not.toHaveBeenCalled();
    expect(utterances.length).toBeGreaterThan(beforeCount);

    // Finish all Page 2 chunks -> must advance into Page 3 chunk, not finish spread early
    for (let i = beforeCount; i < utterances.length; i++) {
      await act(async () => utterances[i].onend?.());
    }
    await act(async () => utterances[utterances.length - 1]?.onend?.());
    expect(utterances.some((u) => u.text.includes("page 3") || u.text.includes("Chapter 3"))).toBe(true);
  });

  it("preserves current playback time across codec retry and preserves requested chunk when error occurs before metadata", () => {
    const chunks: ReadAloudChunk[] = [
      { id: "c0", pageIndex: 0, blockIndex: 0, text: "First." },
      { id: "c1", pageIndex: 0, blockIndex: 0, text: "Second." },
    ];
    const track: PreviewAudioPageTrack = {
      pageIndex: 0,
      pdfPageNumber: 1,
      audioUrl: "/books/audio/test_book/page-01.mp3",
      opusUrl: "/books/audio/test_book/page-01.webm",
      durationMs: 25000,
      chunks: [
        { id: "c0", blockIndex: 0, text: "First.", startMs: 0, endMs: 5000 },
        { id: "c1", blockIndex: 0, text: "Second.", startMs: 12000, endMs: 24000 },
      ],
    };

    // PRRT_kwDOUrokqs665Sef: mid-track failure at 18s retries secondary codec at 18s instead of restarting at 0s
    const audioRetry = new MockAudioElement();
    let currentSource: string | null = null;
    runPrebakedTrackQueue({
      audio: audioRetry as unknown as HTMLAudioElement,
      tracks: [track],
      startTrackIdx: 0,
      initialSeekSec: 0,
      chunks,
      raSettings: DEFAULT_GLOBAL.book_preview.read_aloud,
      getRate: () => 1,
      getCurrentSource: () => currentSource,
      setCurrentSource: (u) => { currentSource = u; },
      setQueue: () => {},
      isStale: () => false,
      onChunkActive: () => {},
      onWordChange: () => {},
      onFinishSpread: () => {},
      onFallbackSpeech: () => {},
      onHardStop: () => {},
    });
    expect(audioRetry.src).toBe("/books/audio/test_book/page-01.webm");
    audioRetry.currentTime = 18;
    audioRetry.onerror?.();
    expect(audioRetry.src).toBe("/books/audio/test_book/page-01.mp3");
    expect(audioRetry.currentTime).toBe(18);

    // PRRT_kwDOUrokqs665Sek: error before metadata in browser that leaves currentTime=0 uses requested chunkIdx (1), not 0
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: vi.fn(), configurable: true });
    Object.defineProperty(window, "speechSynthesis", { value: { speak: vi.fn(), getVoices: () => [] }, configurable: true });
    const preMetaAudio = {
      src: "",
      preload: "",
      readyState: 0,
      playbackRate: 1,
      defaultPlaybackRate: 1,
      preservesPitch: true,
      canPlayType: () => "probably",
      play: () => Promise.resolve(),
      onloadedmetadata: null as (() => void) | null,
      ontimeupdate: null as (() => void) | null,
      onended: null as (() => void) | null,
      onerror: null as (() => void) | null,
      get currentTime() { return 0; },
      set currentTime(_v: number) { /* simulate browser ignoring seek before metadata */ },
    };
    const onFallbackSpeech = vi.fn();
    let preSource: string | null = null;
    runPrebakedTrackQueue({
      audio: preMetaAudio as unknown as HTMLAudioElement,
      tracks: [{ ...track, opusUrl: undefined }],
      startTrackIdx: 0,
      initialSeekSec: 12,
      initialChunkIdx: 1,
      chunks,
      raSettings: DEFAULT_GLOBAL.book_preview.read_aloud,
      getRate: () => 1,
      getCurrentSource: () => preSource,
      setCurrentSource: (u) => { preSource = u; },
      setQueue: () => {},
      isStale: () => false,
      onChunkActive: () => {},
      onWordChange: () => {},
      onFinishSpread: () => {},
      onFallbackSpeech,
      onHardStop: () => {},
    });
    preMetaAudio.onerror?.();
    expect(onFallbackSpeech).toHaveBeenCalledWith(1);
  });
});
