// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";
import {
  classifyPageLandmark,
  classifyPageLandmarkKind,
  enrichSpreadWithLandmarks,
  prependSpokenLandmark,
} from "../src/components/storefront/book-preview-landmarks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flipMocks = vi.hoisted(() => ({
  orientation: "landscape" as "portrait" | "landscape",
  instances: [] as Array<{
    handlers: Record<string, (e: { data: unknown }) => void>;
    flipNext: ReturnType<typeof vi.fn>;
    turnToPage: ReturnType<typeof vi.fn>;
    currentPage: number;
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
        getTextContent: async () => {
          const pages: Record<number, Array<{ str: string; hasEOL: boolean; height: number; transform: number[] }>> = {
            1: [
              { str: "The Quiet Workshop", hasEOL: true, height: 24, transform: [24, 0, 0, 24, 24, 520] },
              { str: "Twelve practical projects for a small home bench", hasEOL: true, height: 11, transform: [11, 0, 0, 11, 24, 460] },
              { str: "ELIAS HARTWELL", hasEOL: true, height: 11, transform: [11, 0, 0, 11, 24, 420] },
            ],
            2: [
              { str: "The Quiet Workshop", hasEOL: true, height: 22, transform: [22, 0, 0, 22, 24, 520] },
              { str: "Elias Hartwell is a pen name.", hasEOL: true, height: 10, transform: [10, 0, 0, 10, 24, 460] },
              { str: "Published by ExpanPress.", hasEOL: true, height: 10, transform: [10, 0, 0, 10, 24, 420] },
            ],
            3: [
              { str: "Contents", hasEOL: true, height: 22, transform: [22, 0, 0, 22, 24, 520] },
              { str: "1. Setting Up the Bench", hasEOL: true, height: 10, transform: [10, 0, 0, 10, 24, 480] },
            ],
            4: [
              { str: "Chapter 1: Setting Up the Bench", hasEOL: true, height: 22, transform: [22, 0, 0, 22, 24, 520] },
              { str: "A workshop does not need a room.", hasEOL: true, height: 10, transform: [10, 0, 0, 10, 24, 480] },
            ],
            5: [
              { str: "Choosing a Corner", hasEOL: true, height: 14, transform: [14, 0, 0, 14, 24, 520] },
              { str: "Look for steady daylight.", hasEOL: true, height: 10, transform: [10, 0, 0, 10, 24, 480] },
            ],
            6: [
              { str: "A calm, practical start", hasEOL: true, height: 12, transform: [12, 0, 0, 12, 24, 520] },
              { str: "Published by ExpanPress.", hasEOL: true, height: 10, transform: [10, 0, 0, 10, 24, 480] },
            ],
          };
          return { items: pages[n] ?? [] };
        },
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
          state.currentPage = Math.min(state.currentPage + 1, 5);
          state.handlers.flip?.({ data: state.currentPage });
        }),
        turnToPage: vi.fn((p: number) => {
          state.currentPage = p;
          state.handlers.flip?.({ data: p });
        }),
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
    flipPrev() {}
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

describe("structural book landmarks (visual headers + spoken Web Speech cues)", () => {
  const labels = DEFAULT_GLOBAL.book_preview.text_structure.page_landmarks;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    flipMocks.orientation = "landscape";
    flipMocks.instances = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => "data:image/png;base64,stub");
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
    vi.restoreAllMocks();
  });

  it("classifies front cover, title page, TOC, part/chapter openers, and back cover accurately", () => {
    expect(classifyPageLandmarkKind(0, 8, [{ kind: "heading", level: 3, text: "Title" }], true)).toBe("front_cover");
    expect(classifyPageLandmarkKind(1, 8, [{ kind: "heading", level: 3, text: "Title" }], true)).toBe("title_page");
    expect(classifyPageLandmarkKind(2, 8, [{ kind: "heading", level: 3, text: "Contents" }], true)).toBe("table_of_contents");
    expect(classifyPageLandmarkKind(3, 8, [{ kind: "heading", level: 3, text: "Part I: Foundations" }], true)).toBe("part_opener");
    expect(classifyPageLandmarkKind(3, 8, [{ kind: "heading", level: 3, text: "Chapter 1: Bench" }], true)).toBe("chapter_opener");
    expect(classifyPageLandmarkKind(7, 8, [{ kind: "paragraph", text: "Blurb" }], true)).toBe("back_cover");
    expect(classifyPageLandmark(1, 8, [{ kind: "heading", level: 3, text: "Title" }], true, labels)).toBe("Title page");

    expect(prependSpokenLandmark("The Quiet Workshop.", "Title page", true)).toBe("Title page. The Quiet Workshop.");
    expect(prependSpokenLandmark("Contents.", "Table of contents", false)).toBe("Contents.");

    const enriched = enrichSpreadWithLandmarks(
      [1, 2],
      [
        [],
        [{ kind: "heading", level: 3, text: "The Quiet Workshop" }],
        [{ kind: "heading", level: 3, text: "Contents" }],
      ],
      8,
      true,
      labels,
      [
        { id: "p1-b0-s0", pageIndex: 1, blockIndex: 0, text: "The Quiet Workshop" },
        { id: "p1-b1-s0", pageIndex: 1, blockIndex: 1, text: "Subtitle" },
        { id: "p2-b0-s0", pageIndex: 2, blockIndex: 0, text: "Contents" },
      ],
    );
    expect(enriched.pageLandmarks).toEqual({ 1: "Title page", 2: "Table of contents" });
    expect(enriched.chunks[0].spokenText).toBe("Title page. The Quiet Workshop");
    expect(enriched.chunks[1].spokenText).toBeUndefined();
    expect(enriched.chunks[2].spokenText).toBeUndefined();
  });

  it("renders landmarks in BookPreviewAccessibleCard headers and speaks Front cover / Title page / Back cover in Web Speech", async () => {
    const spoken: string[] = [];
    class FakeUtterance {
      text: string;
      rate = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        paused: false,
        speaking: false,
        pending: false,
        speak: vi.fn((u: FakeUtterance) => {
          spoken.push(u.text);
        }),
        cancel: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        getVoices: () => [],
      },
      configurable: true,
    });

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
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Page 1 (Front cover)
    expect(container.querySelector('[data-testid="accessible-page-landmark-1"]')?.textContent).toBe("Front cover");
    await act(async () => {
      (container!.querySelector('[data-testid="read-aloud-toggle"]') as HTMLButtonElement).click();
    });
    expect(spoken[0]).toBe("Front cover. The Quiet Workshop");
    // Visual text remains clean without injected landmark
    expect(
      container.querySelector('[data-testid="read-aloud-sentence"][data-chunk-id="p0-b0-s0"]')?.textContent,
    ).toBe("The Quiet Workshop");

    // Flip to Pages 2-3 (Title page + Table of contents)
    await act(async () => {
      (container!.querySelector('button[aria-label="Next preview page"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="accessible-page-landmark-2"]')?.textContent).toBe("Title page");
    expect(container.querySelector('[data-testid="accessible-page-landmark-3"]')?.textContent).toBe("Table of contents");
    expect(spoken[spoken.length - 1]).toBe("Title page. The Quiet Workshop");

    // Jump to Page 6 (Back cover)
    await act(async () => {
      flipMocks.instances[0].turnToPage(5);
    });
    expect(container.querySelector('[data-testid="accessible-page-landmark-6"]')?.textContent).toBe("Back cover");
    expect(spoken[spoken.length - 1]).toBe("Back cover. A calm, practical start");
  });
});
