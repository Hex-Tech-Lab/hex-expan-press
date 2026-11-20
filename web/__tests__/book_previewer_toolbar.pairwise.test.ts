// @vitest-environment jsdom
// Pairwise (PICT) test for BookPreviewer toolbar inputs (zoom level x page x viewport).
// Model: docs/testing/pairwise/book_previewer_toolbar.model.txt
// Rows:  docs/testing/pairwise/book_previewer_toolbar.rows.tsv (18 PICT rows, every row asserted below)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flipMocks = vi.hoisted(() => ({
  orientation: "landscape" as "portrait" | "landscape",
  instances: [] as Array<{
    turnToPage: ReturnType<typeof vi.fn>;
    currentPage: number;
  }>,
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 8,
      getPage: async (n: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 600 * scale }),
        render: () => ({ promise: Promise.resolve() }),
        getTextContent: async () => ({ items: [{ str: `Page ${n} content` }] }),
      }),
    }),
  }),
}));

vi.mock("page-flip", () => {
  class MockPageFlip {
    private handlers: Record<string, (e: { data: unknown }) => void> = {};
    private state = { turnToPage: vi.fn((p: number) => { this.state.currentPage = p; this.handlers.flip?.({ data: p }); }), currentPage: 0 };
    constructor() {
      flipMocks.instances.push(this.state);
    }
    on(event: string, cb: (e: { data: unknown }) => void) {
      this.handlers[event] = cb;
    }
    loadFromImages() {
      this.handlers.init?.({ data: { page: 0, mode: flipMocks.orientation } });
    }
    getOrientation() {
      return flipMocks.orientation;
    }
    getCurrentPageIndex() {
      return this.state.currentPage;
    }
    flipNext() {}
    flipPrev() {}
    turnToPage(p: number) {
      this.state.turnToPage(p);
    }
    destroy() {}
  }
  return { PageFlip: MockPageFlip };
});

import BookPreviewer, {
  buildSpreadGroups,
  formatSpreadLabel,
  parseTargetPageInput,
  resolveZoomIndex,
  spreadIndexForPage,
  type PreviewZoomAction,
} from "../src/components/storefront/book-previewer";

const REPO_ROOT = existsSync(join(process.cwd(), "docs/testing/pairwise"))
  ? process.cwd()
  : resolve(process.cwd(), "..");
const PICT_BIN = "/usr/local/bin/pict";
const MODEL_PATH = join(REPO_ROOT, "docs/testing/pairwise/book_previewer_toolbar.model.txt");
const ROWS_PATH = join(REPO_ROOT, "docs/testing/pairwise/book_previewer_toolbar.rows.tsv");
const EXPECTED_ROW_COUNT = 18;
const TOTAL_PAGES = 8;

interface ToolbarRow {
  rowNum: number;
  viewport: "mobile_390" | "desktop_1560";
  zoom_level: "z100" | "z135" | "z175";
  zoom_action: PreviewZoomAction;
  target_page: "first" | "middle" | "last" | "below_min" | "above_max" | "non_numeric";
  orientation: "portrait" | "landscape";
}

function parseRows(tsv: string): ToolbarRow[] {
  const [header, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = header.split("\t");
  return lines.map((line, i) => {
    const cells = line.split("\t");
    const rec = Object.fromEntries(cols.map((c, idx) => [c, cells[idx]]));
    return { rowNum: i + 1, ...rec } as ToolbarRow;
  });
}

const ZOOM_START_INDEX: Record<ToolbarRow["zoom_level"], number> = {
  z100: 0,
  z135: 1,
  z175: 2,
};

const PAGE_INPUT_VALUE: Record<ToolbarRow["target_page"], string> = {
  first: "1",
  middle: "4",
  last: String(TOTAL_PAGES),
  below_min: "0",
  above_max: "99",
  non_numeric: "abc",
};

const EXPECTED_PAGE_INDEX: Record<ToolbarRow["target_page"], number | null> = {
  first: 0,
  middle: 3,
  last: TOTAL_PAGES - 1,
  below_min: 0,
  above_max: TOTAL_PAGES - 1,
  non_numeric: null,
};

const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");
const ROWS = parseRows(ROWS_TSV);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
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

describe("BookPreviewer toolbar: PICT pairwise (zoom level x page x viewport)", () => {
  it("checked-in rows TSV matches /usr/local/bin/pict output (no model drift)", () => {
    if (!existsSync(PICT_BIN)) {
      if (process.env.CI) throw new Error(`pict binary missing at ${PICT_BIN}`);
      return;
    }
    const generated = execFileSync(PICT_BIN, [MODEL_PATH], { encoding: "utf8" }).trim();
    expect(generated).toBe(ROWS_TSV.trim());
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
  });

  it.each(ROWS)(
    "row $rowNum: viewport=$viewport zoom=$zoom_level action=$zoom_action page=$target_page orientation=$orientation",
    async (row) => {
      const levels = DEFAULT_GLOBAL.book_preview.zoom_levels;
      const startIdx = ZOOM_START_INDEX[row.zoom_level];
      const expectedZoomIdx =
        row.zoom_action === "zoom_in"
          ? Math.min(startIdx + 1, levels.length - 1)
          : row.zoom_action === "zoom_out"
            ? Math.max(startIdx - 1, 0)
            : 0;

      expect(resolveZoomIndex(startIdx, row.zoom_action, levels)).toBe(expectedZoomIdx);
      expect(parseTargetPageInput(PAGE_INPUT_VALUE[row.target_page], TOTAL_PAGES)).toBe(
        EXPECTED_PAGE_INDEX[row.target_page],
      );

      flipMocks.orientation = row.orientation;
      const viewportWidth = row.viewport === "mobile_390" ? 390 : 1560;
      Object.defineProperty(window, "innerWidth", { value: viewportWidth, configurable: true });

      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root!.render(
          React.createElement(BookPreviewer, {
            previewPdfUrl: "/books/previews/sample_the_quiet_workshop.pdf",
            bookTitle: "The Quiet Workshop (Sample)",
            settings: DEFAULT_GLOBAL.book_preview,
          }),
        );
      });
      await flush();
      await flush();

      const zoomInBtn = container.querySelector('[data-testid="book-preview-zoom-in"]') as HTMLButtonElement;
      const zoomOutBtn = container.querySelector('[data-testid="book-preview-zoom-out"]') as HTMLButtonElement;
      const resetBtn = container.querySelector('[data-testid="book-preview-zoom-reset"]') as HTMLButtonElement;

      for (let i = 0; i < startIdx; i++) {
        await act(async () => {
          zoomInBtn.click();
        });
      }

      const targetBtn =
        row.zoom_action === "zoom_in" ? zoomInBtn : row.zoom_action === "zoom_out" ? zoomOutBtn : resetBtn;
      await act(async () => {
        targetBtn.click();
      });

      const zoomViewport = container.querySelector('[data-testid="book-preview-viewport"]');
      expect(zoomViewport?.getAttribute("data-zoom-level")).toBe(String(expectedZoomIdx));
      expect(zoomViewport?.getAttribute("data-zoom")).toBe(String(levels[expectedZoomIdx]));

      const input = container.querySelector('[data-testid="book-preview-goto-input"]') as HTMLInputElement;
      const form = input.closest("form")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, PAGE_INPUT_VALUE[row.target_page]);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });

      const expectedIdx = EXPECTED_PAGE_INDEX[row.target_page] ?? 0;
      const spreads = buildSpreadGroups(TOTAL_PAGES, row.orientation, DEFAULT_GLOBAL.book_preview.show_cover);
      const wantSpread = spreads[spreadIndexForPage(spreads, expectedIdx)] ?? [];
      const wantLabel = formatSpreadLabel(wantSpread, TOTAL_PAGES, DEFAULT_GLOBAL.book_preview.show_cover);
      expect(container.querySelector('[data-testid="book-preview-page-label"]')?.textContent).toBe(wantLabel);
    },
  );
});
