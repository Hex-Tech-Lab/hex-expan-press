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
  }
  return { PageFlip: MockPageFlip };
});

import BookPreviewer, {
  buildSpreadGroups,
  formatSpreadLabel,
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
