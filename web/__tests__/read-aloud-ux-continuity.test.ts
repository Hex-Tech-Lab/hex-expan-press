// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";
import type { PreviewAudioManifest, ReadAloudChunk } from "../src/components/storefront/book-previewer-text";
import { useReadAloud } from "../src/components/storefront/use-read-aloud";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flipMocks = vi.hoisted(() => ({
  orientation: "landscape" as "portrait" | "landscape",
  instances: [] as Array<{
    handlers: Record<string, (e: { data: unknown }) => void>;
    flipNext: ReturnType<typeof vi.fn>;
    flipPrev: ReturnType<typeof vi.fn>;
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
        flipPrev: vi.fn(() => {
          state.currentPage = Math.max(0, state.currentPage - (flipMocks.orientation === "landscape" && state.currentPage > 1 ? 2 : 1));
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
    flipPrev() {
      this.state.flipPrev();
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
  playCalls = 0;
  pauseCalls = 0;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    MockAudioElement.instances.push(this);
  }
  canPlayType = vi.fn((m: string) => (m.includes("opus") ? "probably" : ""));
  load = vi.fn();
  removeAttribute(attr: string) {
    if (attr === "src") this.src = "";
  }
  play = vi.fn(() => {
    this.paused = false;
    this.playCalls += 1;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.pauseCalls += 1;
  });
}

const PREBAKED_MANIFEST: PreviewAudioManifest = {
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
    "4": {
      pageIndex: 3,
      pdfPageNumber: 4,
      audioUrl: "/books/audio/test_book/page-04.webm",
      durationMs: 4000,
      chunks: [
        { id: "p3-b0-s0", blockIndex: 0, text: "Chapter 4", startMs: 120, endMs: 1100 },
        { id: "p3-b1-s0", blockIndex: 1, text: "First sentence on page 4.", startMs: 1320, endMs: 2500 },
        { id: "p3-b1-s1", blockIndex: 1, text: "Second sentence on page 4.", startMs: 2720, endMs: 3900 },
      ],
    },
    "5": {
      pageIndex: 4,
      pdfPageNumber: 5,
      audioUrl: "/books/audio/test_book/page-05.webm",
      durationMs: 4000,
      chunks: [
        { id: "p4-b0-s0", blockIndex: 0, text: "Chapter 5", startMs: 120, endMs: 1100 },
        { id: "p4-b1-s0", blockIndex: 1, text: "First sentence on page 5.", startMs: 1320, endMs: 2500 },
        { id: "p4-b1-s1", blockIndex: 1, text: "Second sentence on page 5.", startMs: 2720, endMs: 3900 },
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

describe("Read Aloud UX continuity, click-to-read, spread resume memory, and hints", () => {
  beforeEach(() => {
    flipMocks.orientation = "landscape";
    flipMocks.instances = [];
    MockAudioElement.instances = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => "data:image/png;base64,stub");
    vi.stubGlobal("Audio", MockAudioElement);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(PREBAKED_MANIFEST), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders right-aligned usage hint and state-aware tooltips from settings_registry.ts", async () => {
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

    // Flip to Pages 2-3 where pre-baked audio tracks are present
    await act(async () => {
      (container!.querySelector('button[aria-label="Next preview page"]') as HTMLButtonElement).click();
    });

    const labels = DEFAULT_GLOBAL.book_preview.read_aloud.labels;
    const hint = container.querySelector('[data-testid="read-aloud-usage-hint"]') as HTMLElement | null;
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe(labels.usage_hint);
    expect(hint!.className).toContain("text-right");
    expect(hint!.className).toContain("ml-auto");

    const toggleBtn = container.querySelector('[data-testid="read-aloud-toggle"]') as HTMLButtonElement;
    expect(toggleBtn.getAttribute("aria-label")).toBe(labels.play);
    expect(toggleBtn.getAttribute("title")).toBe(labels.play_tooltip);

    await act(async () => toggleBtn.click());
    expect(toggleBtn.getAttribute("aria-label")).toBe(labels.pause);
    expect(toggleBtn.getAttribute("title")).toBe(labels.pause_tooltip);

    const stopBtn = container.querySelector('[data-testid="read-aloud-stop"]') as HTMLButtonElement;
    expect(stopBtn.getAttribute("aria-label")).toBe(labels.stop);
    expect(stopBtn.getAttribute("title")).toBe(labels.stop_tooltip);

    await act(async () => toggleBtn.click());
    expect(toggleBtn.getAttribute("aria-label")).toBe(labels.resume);
    expect(toggleBtn.getAttribute("title")).toBe(labels.resume_tooltip);
  });

  it("clicking any sentence seeks pre-baked audio to startMs/1000 and preserves/resets spread memory across pause vs stop", async () => {
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

    // Flip to Pages 2-3 spread (index 1, pages [1, 2])
    const nextBtn = container.querySelector('button[aria-label="Next preview page"]') as HTMLButtonElement;
    await act(async () => nextBtn.click());
    expect(container.querySelector('[data-testid="book-preview-page-label"]')?.textContent).toBe("Pages 2–3 of 6");

    // Expand accessible panel and click the 2nd sentence on Page 3 (p2-b1-s0, startMs=1320)
    await act(async () => {
      (container!.querySelector('[data-testid="book-preview-accessible-toggle"]') as HTMLButtonElement).click();
    });
    const targetSentence = container.querySelector('[data-testid="read-aloud-sentence"][data-chunk-id="p2-b1-s0"]') as HTMLElement;
    expect(targetSentence.getAttribute("role")).toBe("button");
    await act(async () => targetSentence.click());

    const audio = MockAudioElement.instances[0];
    expect(audio.src).toBe("/books/audio/test_book/page-03.webm");
    expect(audio.currentTime).toBeCloseTo(1.32, 2);
    expect(targetSentence.getAttribute("data-active")).toBe("true");

    // Simulate metadata arrival after src swap (Safari/WebKit behavior) -> re-applies seek cleanly
    audio.currentTime = 0;
    await act(async () => audio.onloadedmetadata?.());
    expect(audio.currentTime).toBeCloseTo(1.32, 2);

    // Pause, flip to Pages 4-5, then flip BACK to Pages 2-3 and Resume -> continues from p2-b1-s0!
    const playToggle = container.querySelector('[data-testid="read-aloud-toggle"]') as HTMLButtonElement;
    await act(async () => playToggle.click()); // pause
    expect(playToggle.getAttribute("data-playback-state")).toBe("paused");

    await act(async () => nextBtn.click()); // Pages 4-5
    expect(container.querySelector('[data-testid="book-preview-page-label"]')?.textContent).toBe("Pages 4–5 of 6");

    const prevBtn = container.querySelector('button[aria-label="Previous preview page"]') as HTMLButtonElement;
    await act(async () => prevBtn.click()); // back to Pages 2-3
    expect(container.querySelector('[data-testid="book-preview-page-label"]')?.textContent).toBe("Pages 2–3 of 6");
    expect(
      container.querySelector('[data-testid="read-aloud-sentence"][data-chunk-id="p2-b1-s0"]')?.getAttribute("data-active"),
    ).toBe("true");

    await act(async () => playToggle.click()); // resume
    expect(playToggle.getAttribute("data-playback-state")).toBe("playing");
    expect(audio.src).toBe("/books/audio/test_book/page-03.webm");
    expect(audio.currentTime).toBeCloseTo(1.32, 2);

    // Clicking Stop explicitly resets spread position back to top of Pages 2-3
    await act(async () => {
      (container!.querySelector('[data-testid="read-aloud-stop"]') as HTMLButtonElement).click();
    });
    expect(playToggle.getAttribute("data-playback-state")).toBe("idle");
    await act(async () => playToggle.click());
    expect(audio.src).toBe("/books/audio/test_book/page-02.webm");
    expect(audio.currentTime).toBe(0);
  });

  it("auto-advances across spreads when pre-baked spread ends and survives orientation change on mobile/desktop", async () => {
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

    // Flip to Pages 2-3 and start playing
    await act(async () => {
      (container!.querySelector('button[aria-label="Next preview page"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container!.querySelector('[data-testid="read-aloud-toggle"]') as HTMLButtonElement).click();
    });

    const audio = MockAudioElement.instances[0];
    expect(audio.src).toBe("/books/audio/test_book/page-02.webm");

    // End of Page 2 -> Page 3
    await act(async () => audio.onended?.());
    expect(audio.src).toBe("/books/audio/test_book/page-03.webm");

    // End of Page 3 (end of spread [1, 2]) -> auto-flips to Pages 4-5 and continues playing Page 4!
    await act(async () => audio.onended?.());
    await flush();
    expect(container.querySelector('[data-testid="book-preview-page-label"]')?.textContent).toBe("Pages 4–5 of 6");
    expect(audio.src).toBe("/books/audio/test_book/page-04.webm");
    expect(
      (container.querySelector('[data-testid="read-aloud-toggle"]') as HTMLButtonElement).getAttribute("data-playback-state"),
    ).toBe("playing");

    // Orientation change from landscape -> portrait preserves playback without killing it
    const inst = flipMocks.instances[0];
    await act(async () => inst.emitOrientation("portrait"));
    await flush();
    expect(
      (container.querySelector('[data-testid="read-aloud-toggle"]') as HTMLButtonElement).getAttribute("data-playback-state"),
    ).toBe("playing");
  });

  it("supports Web Speech playFromChunk and auto-advance callback when spread ends", async () => {
    const utterances: Array<{ text: string; onend: (() => void) | null }> = [];
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
    Object.defineProperty(window, "speechSynthesis", {
      value: { paused: false, speaking: false, pending: false, speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: () => [] },
      configurable: true,
    });

    const chunks: ReadAloudChunk[] = [
      { id: "c0", pageIndex: 0, blockIndex: 0, text: "First." },
      { id: "c1", pageIndex: 0, blockIndex: 0, text: "Second." },
    ];
    const onRequestNextPage = vi.fn(() => true);
    let hook!: ReturnType<typeof useReadAloud>;
    function Harness() {
      hook = useReadAloud(chunks, DEFAULT_GLOBAL.book_preview.read_aloud, () => {}, null, "/books/audio", {
        onRequestNextPage,
      });
      return null;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(React.createElement(Harness)));

    await act(async () => hook.playFromChunk("c1"));
    expect(utterances[0].text).toBe("Second.");
    expect(hook.activeChunkId).toBe("c1");

    await act(async () => utterances[0].onend?.());
    expect(onRequestNextPage).toHaveBeenCalledTimes(1);
    expect(hook.playbackState).toBe("playing");
  });
});
