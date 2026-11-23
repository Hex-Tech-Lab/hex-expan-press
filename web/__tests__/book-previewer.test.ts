// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pdfMocks = vi.hoisted(() => ({
  workerSrc: "",
  docUrl: "",
  numPages: 6,
  getDocumentShouldFail: false,
  holdLoad: false,
  release: null as null | (() => void),
  getPage: vi.fn(),
}));

const flipMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    host: HTMLElement;
    settings: Record<string, unknown>;
    images: string[];
    handlers: Record<string, (e: { data: unknown }) => void>;
    flipNext: ReturnType<typeof vi.fn>;
    flipPrev: ReturnType<typeof vi.fn>;
    turnToPage: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    uiUpdate: ReturnType<typeof vi.fn>;
    orientation: "portrait" | "landscape";
    currentPage: number;
  }>,
  renders: [] as Array<{ render: { drawFrame: () => void }; draw: ReturnType<typeof vi.fn> }>,
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {
    set workerSrc(v: string) {
      pdfMocks.workerSrc = v;
    },
    get workerSrc() {
      return pdfMocks.workerSrc;
    },
  },
  getDocument: (url: string) => {
    pdfMocks.docUrl = url;
    if (pdfMocks.getDocumentShouldFail) {
      return { promise: Promise.reject(new Error("404 Not Found")) };
    }
    if (pdfMocks.holdLoad) {
      return {
        promise: new Promise((resolve) => {
          pdfMocks.release = () => resolve({ numPages: pdfMocks.numPages, getPage: pdfMocks.getPage });
        }),
      };
    }
    return {
      promise: Promise.resolve({
        numPages: pdfMocks.numPages,
        getPage: pdfMocks.getPage,
      }),
    };
  },
}));

vi.mock("page-flip", () => {
  class MockPageFlip {
    private state: (typeof flipMocks.instances)[number];
    render?: { drawFrame: () => void };
    constructor(host: HTMLElement, settings: Record<string, unknown>) {
      this.state = {
        host,
        settings,
        images: [],
        handlers: {},
        flipNext: vi.fn(() => {
          this.state.currentPage = Math.min(this.state.currentPage + 1, this.state.images.length - 1);
          this.state.handlers.flip?.({ data: this.state.currentPage });
        }),
        flipPrev: vi.fn(() => {
          this.state.currentPage = Math.max(0, this.state.currentPage - 1);
          this.state.handlers.flip?.({ data: this.state.currentPage });
        }),
        turnToPage: vi.fn((p: number) => {
          this.state.currentPage = p;
          this.state.handlers.flip?.({ data: p });
        }),
        destroy: vi.fn(() => {
          host.remove();
        }),
        uiUpdate: vi.fn(),
        orientation: "landscape",
        currentPage: 0,
      };
      flipMocks.instances.push(this.state);
    }
    on(event: string, cb: (e: { data: unknown }) => void) {
      this.state.handlers[event] = cb;
    }
    loadFromImages(images: string[]) {
      // Like the real library, render is created during loadFromImages (not the constructor),
      // and drawFrame lives on the prototype: an own property overrides it, deleting it restores it.
      const draw = vi.fn();
      const render = Object.create({ drawFrame() { draw(); } }) as { drawFrame: () => void };
      flipMocks.renders.push({ render, draw });
      this.render = render;
      this.state.images = images;
      this.state.handlers.init?.({ data: { page: 0, mode: this.state.orientation } });
    }
    getOrientation() {
      return this.state.orientation;
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
    destroy() {
      this.state.destroy();
    }
    getUI() {
      return { update: this.state.uiUpdate };
    }
  }
  return { PageFlip: MockPageFlip };
});

import BookPreviewer, {
  buildSpreadAccessibleModel,
  buildSpreadGroups,
  extractStructuredPageBlocks,
  formatSpreadLabel,
  parseTargetPageInput,
  resolveZoomIndex,
  splitIntoSentenceChunks,
  spreadIndexForPage,
} from "../src/components/storefront/book-previewer";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mountPreviewer(props?: Partial<React.ComponentProps<typeof BookPreviewer>>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(BookPreviewer, {
        previewPdfUrl: "/books/previews/duane.pdf",
        bookTitle: "You Don't Need a Million Dollars to Retire",
        settings: DEFAULT_GLOBAL.book_preview,
        ...props,
      }),
    );
  });
  await flush();
  await flush();
}

beforeEach(() => {
  pdfMocks.workerSrc = "";
  pdfMocks.docUrl = "";
  pdfMocks.numPages = 6;
  pdfMocks.getDocumentShouldFail = false;
  pdfMocks.getPage.mockReset();
  pdfMocks.getPage.mockImplementation(async (n: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 600 * scale }),
    render: () => ({ promise: Promise.resolve() }),
    getTextContent: async () => ({ items: [{ str: `Preview text on page ${n}` }] }),
  }));
  flipMocks.instances = [];

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => "data:image/png;base64,stub");
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
  vi.restoreAllMocks();
});

describe("spread helpers", () => {
  it("builds landscape cover + 2-page interior spreads + back cover when showCover is true", () => {
    expect(buildSpreadGroups(6, "landscape", true)).toEqual([[0], [1, 2], [3, 4], [5]]);
    expect(buildSpreadGroups(6, "portrait", true)).toEqual([[0], [1], [2], [3], [4], [5]]);
    expect(spreadIndexForPage([[0], [1, 2], [3, 4], [5]], 2)).toBe(1);
    expect(formatSpreadLabel([0], 6, true)).toBe("Front cover · Page 1 of 6");
    expect(formatSpreadLabel([1, 2], 6, true)).toBe("Pages 2–3 of 6");
    expect(formatSpreadLabel([5], 6, true)).toBe("Back cover · Page 6 of 6");
  });
});

describe("BookPreviewer component", () => {
  it("configures PDF.js worker from settings, respects max_preview_pages cap, and mounts StPageFlip on an inner stage", async () => {
    pdfMocks.numPages = 24;
    await mountPreviewer({
      settings: { ...DEFAULT_GLOBAL.book_preview, max_preview_pages: 6 },
    });

    expect(pdfMocks.workerSrc).toBe(DEFAULT_GLOBAL.book_preview.pdf_worker_src);
    expect(pdfMocks.docUrl).toBe("/books/previews/duane.pdf");
    expect(pdfMocks.getPage).toHaveBeenCalledTimes(6);

    const inst = flipMocks.instances[0];
    expect(inst).toBeDefined();
    expect(inst.images).toHaveLength(6);
    expect(inst.settings.showCover).toBe(true);
    expect(inst.settings.usePortrait).toBe(true);
    expect(inst.settings.size).toBe("stretch");
    expect(inst.settings.flippingTime).toBe(DEFAULT_GLOBAL.book_preview.flipping_time_ms);
    expect(inst.host.getAttribute("data-testid")).toBe("book-preview-stage");

    const label = container!.querySelector('[data-testid="book-preview-page-label"]');
    expect(label?.textContent).toBe("Front cover · Page 1 of 6");
  });

  it("uses coverImageUrl for the first page image when supplied", async () => {
    await mountPreviewer({
      coverImageUrl: "/books/covers/sample_the_quiet_workshop.webp",
    });
    const inst = flipMocks.instances[0];
    expect(inst).toBeDefined();
    expect(inst.images[0]).toBe("/books/covers/sample_the_quiet_workshop.webp");
  });

  it("turns pages via Prev/Next buttons and keyboard arrows, updating spread label and accessible text", async () => {
    await mountPreviewer();
    const inst = flipMocks.instances[0];
    const prevBtn = container!.querySelector('button[aria-label="Previous preview page"]') as HTMLButtonElement;
    const nextBtn = container!.querySelector('button[aria-label="Next preview page"]') as HTMLButtonElement;

    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(false);

    await act(async () => {
      nextBtn.click();
    });
    expect(inst.flipNext).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('[data-testid="book-preview-page-label"]')?.textContent).toBe("Pages 2–3 of 6");
    expect(container!.querySelector('[data-testid="book-preview-accessible-text"]')?.textContent).toContain("Preview text on page 2");
    expect(container!.querySelector('[data-testid="book-preview-accessible-text"]')?.textContent).toContain("Preview text on page 3");
    expect(prevBtn.disabled).toBe(false);

    const section = container!.querySelector('[data-testid="book-preview-section"]') as HTMLElement;
    await act(async () => {
      section.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(inst.flipPrev).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('[data-testid="book-preview-page-label"]')?.textContent).toBe("Front cover · Page 1 of 6");
  });

  it("renders a graceful alert state when the preview PDF fails to load", async () => {
    pdfMocks.getDocumentShouldFail = true;
    await mountPreviewer();

    const alert = container!.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Preview unavailable right now");
    expect(alert?.textContent).toContain("404 Not Found");
  });

  it("destroys the PageFlip instance cleanly on unmount without throwing", async () => {
    await mountPreviewer();
    const inst = flipMocks.instances[0];
    await act(async () => {
      root!.unmount();
      root = null;
    });
    expect(inst.destroy).toHaveBeenCalledTimes(1);
  });

  it("renders accessible toolbar with 2 zoom-in levels, zoom out, reset, and go-to-page driven by settings", async () => {
    expect(resolveZoomIndex(0, "zoom_in", [1, 1.35, 1.75])).toBe(1);
    expect(resolveZoomIndex(2, "zoom_in", [1, 1.35, 1.75])).toBe(2);
    expect(resolveZoomIndex(1, "zoom_out", [1, 1.35, 1.75])).toBe(0);
    expect(resolveZoomIndex(2, "reset", [1, 1.35, 1.75])).toBe(0);
    expect(parseTargetPageInput("4", 6)).toBe(3);
    expect(parseTargetPageInput("99", 6)).toBe(5);
    expect(parseTargetPageInput("0", 6)).toBe(0);
    expect(parseTargetPageInput("abc", 6)).toBeNull();

    await mountPreviewer();
    const labels = DEFAULT_GLOBAL.book_preview.toolbar_labels;
    const toolbar = container!.querySelector(`[role="toolbar"][aria-label="${labels.toolbar_aria_label}"]`);
    expect(toolbar).not.toBeNull();

    const zoomIn = container!.querySelector(`button[aria-label="${labels.zoom_in}"]`) as HTMLButtonElement;
    const zoomOut = container!.querySelector(`button[aria-label="${labels.zoom_out}"]`) as HTMLButtonElement;
    const reset = container!.querySelector(`button[aria-label="${labels.reset_zoom}"]`) as HTMLButtonElement;
    const zoomLabel = container!.querySelector('[data-testid="book-preview-zoom-label"]')!;
    const viewport = container!.querySelector('[data-testid="book-preview-viewport"]')!;

    expect(zoomIn.getAttribute("title")).toBe(labels.zoom_in);
    expect(zoomOut.getAttribute("title")).toBe(labels.zoom_out);
    expect(reset.getAttribute("title")).toBe(labels.reset_zoom);
    expect(zoomOut.disabled).toBe(true);
    expect(reset.disabled).toBe(true);
    expect(zoomIn.disabled).toBe(false);
    expect(zoomLabel.textContent).toBe("100%");

    await act(async () => { zoomIn.click(); });
    expect(zoomLabel.textContent).toBe("135%");
    expect(viewport.getAttribute("data-zoom")).toBe("1.35");
    expect(zoomOut.disabled).toBe(false);
    expect(reset.disabled).toBe(false);

    await act(async () => { zoomIn.click(); });
    expect(zoomLabel.textContent).toBe("175%");
    expect(viewport.getAttribute("data-zoom")).toBe("1.75");
    expect(zoomIn.disabled).toBe(true);

    await act(async () => { zoomOut.click(); });
    expect(zoomLabel.textContent).toBe("135%");
    expect(zoomIn.disabled).toBe(false);

    await act(async () => { reset.click(); });
    expect(zoomLabel.textContent).toBe("100%");
    expect(reset.disabled).toBe(true);

    // Go to page input and keyboard guard (ArrowLeft inside input does not flip page)
    const input = container!.querySelector('[data-testid="book-preview-goto-input"]') as HTMLInputElement;
    expect(input.getAttribute("title")).toBe(labels.go_to_page);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(flipMocks.instances[0].flipPrev).not.toHaveBeenCalled();

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "4");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(flipMocks.instances[0].turnToPage).toHaveBeenCalledWith(3);
    expect(container!.querySelector('[data-testid="book-preview-page-label"]')?.textContent).toBe("Pages 4–5 of 6");
  });
});

const ioMocks = {
  callbacks: [] as Array<(entries: Array<{ isIntersecting: boolean }>) => void>,
  fire(isIntersecting: boolean) {
    for (const cb of ioMocks.callbacks) cb([{ isIntersecting }]);
  },
};

class MockIntersectionObserver {
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    ioMocks.callbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("BookPreviewer visibility gate and focus", () => {
  beforeEach(() => {
    ioMocks.callbacks = [];
    flipMocks.renders.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a visible keyboard focus ring on the page region", async () => {
    await mountPreviewer();
    const region = container!.querySelector('[role="region"]') as HTMLElement | null;
    expect(region).not.toBeNull();
    expect(region!.className).not.toMatch(/focus:outline-none/);
  });

  it("mounts the page-flip book only once the section first comes into view", async () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    await mountPreviewer();
    expect(flipMocks.instances).toHaveLength(0);

    await act(async () => {
      ioMocks.fire(true);
    });
    await flush();
    await flush();
    expect(flipMocks.instances).toHaveLength(1);
  });

  it("pauses the page-flip redraw while the section is out of view and resumes it when it returns", async () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    await mountPreviewer();
    await act(async () => {
      ioMocks.fire(true);
    });
    await flush();
    await flush();
    const { render, draw } = flipMocks.renders[0];

    render.drawFrame();
    expect(draw).toHaveBeenCalledTimes(1);

    await act(async () => {
      ioMocks.fire(false);
    });
    render.drawFrame();
    expect(draw).toHaveBeenCalledTimes(1);

    await act(async () => {
      ioMocks.fire(true);
    });
    render.drawFrame();
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it("keeps render paused when IntersectionObserver reports not-visible before load completes", async () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    let releaseFirstPage!: () => void;
    const firstPageGate = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });
    pdfMocks.getPage.mockImplementation(async (n: number) => {
      if (n === 1) await firstPageGate;
      return {
        getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 600 * scale }),
        render: () => ({ promise: Promise.resolve() }),
        getTextContent: async () => ({ items: [{ str: `Preview text on page ${n}` }] }),
      };
    });

    await mountPreviewer();
    await act(async () => {
      ioMocks.fire(true);
    });
    await act(async () => {
      ioMocks.fire(false);
    });

    releaseFirstPage();
    await flush();
    await flush();

    expect(flipMocks.renders).toHaveLength(1);
    const { render, draw } = flipMocks.renders[0];
    render.drawFrame();
    expect(draw).not.toHaveBeenCalled();

    await act(async () => {
      ioMocks.fire(true);
    });
    render.drawFrame();
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("stops redrawing and destroys the book when the component unmounts", async () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    await mountPreviewer();
    await act(async () => {
      ioMocks.fire(true);
    });
    await flush();
    await flush();
    const { render, draw } = flipMocks.renders[0];

    await act(async () => {
      root!.unmount();
    });
    root = null;
    const drawnBefore = draw.mock.calls.length;
    render.drawFrame();
    expect(draw.mock.calls.length).toBe(drawnBefore);
    expect(flipMocks.instances[0].destroy).toHaveBeenCalledTimes(1);
  });
});

interface MockSpeechState {
  paused: boolean;
  speaking: boolean;
  spoken: Array<{ text: string; rate: number; instance: MockUtterance }>;
  cancelCount: number;
  pauseCount: number;
  resumeCount: number;
}

class MockUtterance {
  text: string;
  rate = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

function installSpeechMock(): MockSpeechState {
  const state: MockSpeechState = {
    paused: false,
    speaking: false,
    spoken: [],
    cancelCount: 0,
    pauseCount: 0,
    resumeCount: 0,
  };
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    value: MockUtterance,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "speechSynthesis", {
    value: {
      get paused() {
        return state.paused;
      },
      get speaking() {
        return state.speaking;
      },
      speak: vi.fn((u: MockUtterance) => {
        state.speaking = true;
        state.paused = false;
        state.spoken.push({ text: u.text, rate: u.rate, instance: u });
        u.onstart?.();
      }),
      cancel: vi.fn(() => {
        state.cancelCount += 1;
        state.speaking = false;
        state.paused = false;
      }),
      pause: vi.fn(() => {
        state.pauseCount += 1;
        state.paused = true;
      }),
      resume: vi.fn(() => {
        state.resumeCount += 1;
        state.paused = false;
      }),
    },
    configurable: true,
    writable: true,
  });
  return state;
}

describe("BookPreviewer container resize re-sync", () => {
  // Stub ResizeObserver so the test can drive the callback directly. The component observes its host node;
  // jsdom reports clientWidth 0, so each observed element gets a width set here before the callback fires.
  const observed: Element[] = [];
  const callbacks: Array<() => void> = [];
  class MockResizeObserver {
    cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
      callbacks.push(cb);
    }
    observe(el: Element) {
      observed.push(el);
    }
    unobserve() {}
    disconnect() {
      // Drop this observer's callback so a torn-down observer cannot satisfy a later assertion.
      const idx = callbacks.indexOf(this.cb);
      if (idx >= 0) callbacks.splice(idx, 1);
    }
  }

  beforeEach(() => {
    observed.length = 0;
    callbacks.length = 0;
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setObservedWidth(px: number) {
    for (const el of observed) {
      Object.defineProperty(el, "clientWidth", { configurable: true, value: px });
    }
  }

  function fireResize() {
    for (const cb of [...callbacks]) cb();
  }

  it("keeps the page-flip host laid out but invisible while loading, never sr-only, and visible once ready", async () => {
    pdfMocks.holdLoad = true;
    try {
      await mountPreviewer();
      await flush();
      const regionWhileLoading = container!.querySelector('[role="region"][data-orientation]') as HTMLElement | null;
      expect(regionWhileLoading).not.toBeNull();
      expect(regionWhileLoading!.className).toContain("invisible");
      expect(regionWhileLoading!.className).not.toContain("sr-only");
    } finally {
      pdfMocks.holdLoad = false;
    }
    await act(async () => {
      pdfMocks.release?.();
    });
    await flush();
    await flush();
    const regionReady = container!.querySelector('[role="region"][data-orientation]') as HTMLElement | null;
    expect(regionReady).not.toBeNull();
    expect(regionReady!.className).not.toContain("invisible");
    expect(regionReady!.className).not.toContain("sr-only");
  });

  it("calls getUI().update() when the container width changes with no window resize", async () => {
    await mountPreviewer();
    await flush();
    await flush();
    const inst = flipMocks.instances[0];
    expect(inst).toBeDefined();
    inst.uiUpdate.mockClear();

    await act(async () => {
      setObservedWidth(720);
      fireResize();
      await flush();
    });
    expect(inst.uiUpdate).toHaveBeenCalled();
  });

  it("ignores container resizes smaller than resize_min_delta_px", async () => {
    await mountPreviewer({ settings: { ...DEFAULT_GLOBAL.book_preview, resize_min_delta_px: 10 } });
    await flush();
    await flush();
    const inst = flipMocks.instances[0];
    inst.uiUpdate.mockClear();

    await act(async () => {
      setObservedWidth(720);
      fireResize();
      await flush();
    });
    const callsAfterFirst = inst.uiUpdate.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await act(async () => {
      setObservedWidth(725);
      fireResize();
      await flush();
    });
    expect(inst.uiUpdate.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe("structured accessible text extraction and chunking", () => {
  it("extracts headings, drop-caps, list items, and paragraphs from pdf.js text items", () => {
    const ts = DEFAULT_GLOBAL.book_preview.text_structure;
    const blocks = extractStructuredPageBlocks(
      [
        { str: "Chapter 1: Setting Up the", hasEOL: true, height: 24, transform: [24, 0, 0, 24, 24, 520] },
        { str: "Bench", hasEOL: false, height: 24, transform: [24, 0, 0, 24, 24, 484] },
        { str: "Tools Needed", hasEOL: true, height: 14, transform: [14, 0, 0, 14, 24, 440] },
        { str: "T", hasEOL: false, height: 34, transform: [34, 0, 0, 34, 24, 390] },
        { str: "his bench fits in a corner.", hasEOL: true, height: 10.5, transform: [10.5, 0, 0, 10.5, 48, 396] },
        { str: "Keep good light overhead.", hasEOL: true, height: 10.5, transform: [10.5, 0, 0, 10.5, 48, 380] },
        { str: "• Hand saw", hasEOL: true, height: 10.5, transform: [10.5, 0, 0, 10.5, 32, 340] },
        { str: "• Block plane", hasEOL: true, height: 10.5, transform: [10.5, 0, 0, 10.5, 32, 323] },
        { str: "1. First project", hasEOL: true, height: 10.5, transform: [10.5, 0, 0, 10.5, 32, 290] },
        { str: "2. Second project . . . . . . 12", hasEOL: true, height: 10.5, transform: [10.5, 0, 0, 10.5, 32, 270] },
      ],
      ts,
    );

    expect(blocks).toEqual([
      { kind: "heading", level: 3, text: "Chapter 1: Setting Up the Bench" },
      { kind: "heading", level: 4, text: "Tools Needed" },
      { kind: "paragraph", text: "This bench fits in a corner. Keep good light overhead." },
      { kind: "list-item", text: "Hand saw" },
      { kind: "list-item", text: "Block plane" },
      { kind: "list-item", text: "1. First project" },
      { kind: "list-item", text: "2. Second project — 12" },
    ]);
  });

  it("splits long text into sentence chunks capped at max_chunk_chars", () => {
    const chunks = splitIntoSentenceChunks(
      "First short sentence. Second sentence is deliberately quite long, with a comma clause, so it must split cleanly below the cap without cutting mid-word.",
      70,
    );
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(70);
    }

    const spreadModel = buildSpreadAccessibleModel(
      [0],
      [[{ kind: "paragraph", text: "One sentence. Two sentences." }]],
      180,
    );
    expect(spreadModel.chunks.map((c) => c.text)).toEqual(["One sentence.", "Two sentences."]);
  });
});

describe("BookPreviewer Read Aloud controls and lifecycle", () => {
  afterEach(() => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
  });

  it("hides Read Aloud controls when speechSynthesis is unsupported, while keeping structured disclosure working", async () => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    pdfMocks.getPage.mockImplementation(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 600 * scale }),
      render: () => ({ promise: Promise.resolve() }),
      getTextContent: async () => ({
        items: [
          { str: "Chapter 1: Intro", hasEOL: true, height: 22, transform: [22, 0, 0, 22, 24, 500] },
          { str: "Body paragraph line.", hasEOL: true, height: 10, transform: [10, 0, 0, 10, 24, 460] },
        ],
      }),
    }));

    await mountPreviewer();
    expect(container!.querySelector('[data-testid="read-aloud-controls"]')).toBeNull();

    const toggle = container!.querySelector('[data-testid="book-preview-accessible-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const panelId = toggle.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();

    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(panelId!);
    expect(panel?.hidden).toBe(false);
    expect(panel?.querySelector("h3")?.textContent).toBe("Chapter 1: Intro");
    expect(panel?.querySelector("p:not(.font-mono)")?.textContent).toBe("Body paragraph line.");
  });

  it("plays, highlights active sentence, pauses/resumes, cycles speed, announces completion, and stops cleanly", async () => {
    const speech = installSpeechMock();
    pdfMocks.getPage.mockImplementation(async (n: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 600 * scale }),
      render: () => ({ promise: Promise.resolve() }),
      getTextContent: async () => ({
        items: [
          { str: `Chapter ${n}`, hasEOL: true, height: 22, transform: [22, 0, 0, 22, 24, 520] },
          { str: `First sentence on page ${n}. Second sentence on page ${n}.`, hasEOL: true, height: 10, transform: [10, 0, 0, 10, 24, 480] },
        ],
      }),
    }));

    await mountPreviewer();
    const toggle = container!.querySelector('[data-testid="book-preview-accessible-toggle"]') as HTMLButtonElement;
    const playBtn = container!.querySelector('[data-testid="read-aloud-toggle"]') as HTMLButtonElement;
    const speedBtn = container!.querySelector('[data-testid="read-aloud-speed"]') as HTMLButtonElement;
    const labels = DEFAULT_GLOBAL.book_preview.read_aloud.labels;

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(playBtn.getAttribute("aria-label")).toBe(labels.play);
    expect(speedBtn.textContent).toBe("1×");
    expect(container!.querySelector('[data-testid="read-aloud-stop"]')).toBeNull();

    // Play auto-expands the panel and highlights chunk 0
    await act(async () => {
      playBtn.click();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(playBtn.getAttribute("aria-label")).toBe(labels.pause);
    expect(container!.querySelector('[data-testid="read-aloud-stop"]')).not.toBeNull();
    expect(speech.spoken).toHaveLength(1);
    expect(speech.spoken[0].text).toBe("Chapter 1");
    expect(speech.spoken[0].rate).toBe(1);

    const activeSentences = container!.querySelectorAll('[data-testid="read-aloud-sentence"][data-active="true"]');
    expect(activeSentences).toHaveLength(1);
    expect(activeSentences[0].textContent).toBe("Chapter 1");
    expect(activeSentences[0].className).toContain("motion-reduce:transition-none");

    // Advance to next sentence via onend
    await act(async () => {
      speech.spoken[0].instance.onend?.();
    });
    expect(speech.spoken).toHaveLength(2);
    expect(speech.spoken[1].text).toBe("First sentence on page 1.");

    // Cycle speed while playing restarts current chunk at 1.25x
    await act(async () => {
      speedBtn.click();
    });
    expect(speedBtn.textContent).toBe("1.25×");
    expect(speech.spoken).toHaveLength(3);
    expect(speech.spoken[2].rate).toBe(1.25);
    expect(speech.spoken[2].text).toBe("First sentence on page 1.");

    // Pause -> Resume
    await act(async () => {
      playBtn.click();
    });
    expect(playBtn.getAttribute("aria-label")).toBe(labels.resume);
    expect(speech.pauseCount).toBe(1);

    await act(async () => {
      playBtn.click();
    });
    expect(playBtn.getAttribute("aria-label")).toBe(labels.pause);
    expect(speech.resumeCount).toBe(1);

    // Finish remaining utterances on Page 1 -> auto-advances to Pages 2-3 and keeps playing
    await act(async () => {
      speech.spoken[2].instance.onend?.();
    });
    await act(async () => {
      speech.spoken[3].instance.onend?.();
    });
    expect(container!.querySelector('[data-testid="book-preview-page-label"]')?.textContent).toBe("Pages 2–3 of 6");
    expect(playBtn.getAttribute("aria-label")).toBe(labels.pause);

    // Jump to final page (Back cover, page 6) and finish its utterances -> goes idle and announces completion
    await act(async () => {
      flipMocks.instances[0].turnToPage(5);
    });
    let safety = 0;
    while (playBtn.getAttribute("aria-label") === labels.pause && safety++ < 10) {
      await act(async () => {
        speech.spoken[speech.spoken.length - 1].instance.onend?.();
      });
    }
    expect(playBtn.getAttribute("aria-label")).toBe(labels.play);
    expect(container!.querySelector('[data-testid="read-aloud-status"]')?.textContent).toBe(labels.finished_announcement);

    // Return to Page 1, then verify stop on collapse, pagehide, page flip, and unmount
    await act(async () => {
      flipMocks.instances[0].turnToPage(0);
    });
    await act(async () => {
      playBtn.click();
    });
    const cancelsBeforeCollapse = speech.cancelCount;
    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(playBtn.getAttribute("aria-label")).toBe(labels.play);
    expect(speech.cancelCount).toBeGreaterThan(cancelsBeforeCollapse);

    // Restart, then pagehide stops speech
    await act(async () => {
      playBtn.click();
    });
    const cancelsBeforeHide = speech.cancelCount;
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(playBtn.getAttribute("aria-label")).toBe(labels.play);
    expect(speech.cancelCount).toBeGreaterThan(cancelsBeforeHide);

    // Restart, then a page turn keeps playing (continue_on_page_turn, default on) and speaks the new page from its top
    await act(async () => {
      playBtn.click();
    });
    const spokenBeforeFlip = speech.spoken.length;
    const cancelsBeforeFlip = speech.cancelCount;
    await act(async () => {
      (container!.querySelector('button[aria-label="Next preview page"]') as HTMLButtonElement).click();
    });
    expect(playBtn.getAttribute("aria-label")).toBe(labels.pause);
    expect(speech.cancelCount).toBeGreaterThan(cancelsBeforeFlip);
    expect(speech.spoken.length).toBeGreaterThan(spokenBeforeFlip);
    expect(speech.spoken[speech.spoken.length - 1].text).toContain("Chapter 2");
    await act(async () => {
      (container!.querySelector('[data-testid="read-aloud-stop"]') as HTMLButtonElement).click();
    });
    expect(playBtn.getAttribute("aria-label")).toBe(labels.play);

    // Restart, then unmount cancels speech
    await act(async () => {
      playBtn.click();
    });
    const cancelsBeforeUnmount = speech.cancelCount;
    await act(async () => {
      root!.unmount();
    });
    root = null;
    expect(speech.cancelCount).toBeGreaterThan(cancelsBeforeUnmount);
  });
});
