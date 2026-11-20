// @vitest-environment jsdom
// Pairwise (PICT) test for BookPreviewer Read Aloud & disclosure controls.
// Model: docs/testing/pairwise/book_previewer_read_aloud.model.txt
// Rows:  docs/testing/pairwise/book_previewer_read_aloud.rows.tsv (30 PICT rows, every row asserted below)
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
    private handlers: Record<string, (e: { data: unknown }) => void> = {};
    private currentPage = 0;
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
      return this.currentPage;
    }
    flipNext() {
      this.currentPage = Math.min(this.currentPage + 1, 5);
      this.handlers.flip?.({ data: this.currentPage });
    }
    flipPrev() {
      this.currentPage = Math.max(0, this.currentPage - 1);
      this.handlers.flip?.({ data: this.currentPage });
    }
    turnToPage(p: number) {
      this.currentPage = p;
      this.handlers.flip?.({ data: p });
    }
    destroy() {}
  }
  return { PageFlip: MockPageFlip };
});

import BookPreviewer from "../src/components/storefront/book-previewer";

const REPO_ROOT = existsSync(join(process.cwd(), "docs/testing/pairwise"))
  ? process.cwd()
  : resolve(process.cwd(), "..");
const PICT_BIN = "/usr/local/bin/pict";
const MODEL_PATH = join(REPO_ROOT, "docs/testing/pairwise/book_previewer_read_aloud.model.txt");
const ROWS_PATH = join(REPO_ROOT, "docs/testing/pairwise/book_previewer_read_aloud.rows.tsv");
const EXPECTED_ROW_COUNT = 30;

interface ReadAloudRow {
  rowNum: number;
  browser_support: "supported" | "unsupported";
  voice_set: "natural_available" | "legacy_only" | "none_yet";
  boundary_events: "yes" | "no";
  playback_state: "idle" | "playing" | "paused";
  speed_rate: "r075" | "r100" | "r125" | "r150";
  panel_collapsed: "collapsed" | "expanded";
  spread_size: "single_page" | "two_page";
  action: "play" | "pause" | "speed_change_mid_sentence" | "stop" | "toggle_panel" | "page_flip" | "page_hide";
}

function parseRows(tsv: string): ReadAloudRow[] {
  const [header, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = header.split("\t");
  return lines.map((line, i) => {
    const cells = line.split("\t");
    const rec = Object.fromEntries(cols.map((c, idx) => [c, cells[idx]]));
    return { rowNum: i + 1, ...rec } as ReadAloudRow;
  });
}

const RATE_VALUE: Record<ReadAloudRow["speed_rate"], number> = {
  r075: 0.75,
  r100: 1,
  r125: 1.25,
  r150: 1.5,
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

type VoiceLike = { name: string; lang: string };
type SpokenUtterance = { text: string; rate: number; voiceName: string | null };

const NATURAL_VOICE: VoiceLike = { name: "Microsoft Aria Online (Natural) - English (United States)", lang: "en-US" };
const DAVID_VOICE: VoiceLike = { name: "Microsoft David - English (United States)", lang: "en-US" };
const ZIRA_VOICE: VoiceLike = { name: "Microsoft Zira - English (United States)", lang: "en-US" };
const VOICE_SETS: Record<ReadAloudRow["voice_set"], VoiceLike[]> = {
  natural_available: [DAVID_VOICE, NATURAL_VOICE, ZIRA_VOICE],
  legacy_only: [DAVID_VOICE, ZIRA_VOICE],
  none_yet: [],
};
/** The voice the registry ranking must pick for each browser voice set. */
const EXPECTED_VOICE: Record<ReadAloudRow["voice_set"], string | null> = {
  natural_available: NATURAL_VOICE.name,
  legacy_only: ZIRA_VOICE.name,
  none_yet: null,
};

class MockUtterance {
  text: string;
  rate = 1;
  voice: VoiceLike | null = null;
  onboundary: ((ev: { charIndex: number }) => void) | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

function installSpeechMock(row: ReadAloudRow) {
  const state = { paused: false, cancelCount: 0, spoken: [] as SpokenUtterance[] };
  const voices = VOICE_SETS[row.voice_set];
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
      getVoices: () => voices,
      speak: vi.fn((u: MockUtterance) => {
        state.paused = false;
        state.spoken.push({ text: u.text, rate: u.rate, voiceName: u.voice?.name ?? null });
        u.onstart?.();
        if (row.boundary_events === "yes") {
          // A voice that reports word boundaries: the second word starts after the first space.
          u.onboundary?.({ charIndex: u.text.indexOf(" ") + 1 });
        }
      }),
      cancel: vi.fn(() => {
        state.cancelCount += 1;
        state.paused = false;
      }),
      pause: vi.fn(() => {
        state.paused = true;
      }),
      resume: vi.fn(() => {
        state.paused = false;
      }),
    },
    configurable: true,
    writable: true,
  });
  return state;
}

beforeEach(() => {
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
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
  delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
  vi.restoreAllMocks();
});

describe("BookPreviewer Read Aloud: PICT pairwise (browser support x state x speed x collapsed x spread x action)", () => {
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
    "row $rowNum: support=$browser_support state=$playback_state speed=$speed_rate panel=$panel_collapsed spread=$spread_size action=$action",
    async (row) => {
      const speech = row.browser_support === "supported" ? installSpeechMock(row) : null;
      flipMocks.orientation = row.spread_size === "two_page" ? "landscape" : "portrait";

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

      if (row.spread_size === "two_page") {
        await act(async () => {
          (container!.querySelector('button[aria-label="Next preview page"]') as HTMLButtonElement).click();
        });
      }

      const panelToggle = container.querySelector('[data-testid="book-preview-accessible-toggle"]') as HTMLButtonElement;
      const raControls = container.querySelector('[data-testid="read-aloud-controls"]');

      if (row.browser_support === "unsupported") {
        expect(raControls).toBeNull();
        if (row.panel_collapsed === "expanded") {
          await act(async () => {
            panelToggle.click();
          });
        }
        const beforeExpanded = panelToggle.getAttribute("aria-expanded");
        await act(async () => {
          panelToggle.click();
        });
        expect(panelToggle.getAttribute("aria-expanded")).toBe(beforeExpanded === "true" ? "false" : "true");
        return;
      }

      expect(raControls).not.toBeNull();
      const playToggle = container.querySelector('[data-testid="read-aloud-toggle"]') as HTMLButtonElement;
      const speedBtn = container.querySelector('[data-testid="read-aloud-speed"]') as HTMLButtonElement;

      const rates = DEFAULT_GLOBAL.book_preview.read_aloud.rates;
      const targetRate = RATE_VALUE[row.speed_rate];
      const defaultIdx = rates.indexOf(DEFAULT_GLOBAL.book_preview.read_aloud.default_rate);
      const targetIdx = rates.indexOf(targetRate);
      const clicksNeeded = (targetIdx - defaultIdx + rates.length) % rates.length;
      for (let i = 0; i < clicksNeeded; i++) {
        await act(async () => {
          speedBtn.click();
        });
      }
      expect(speedBtn.getAttribute("data-rate")).toBe(String(targetRate));

      if (row.panel_collapsed === "expanded" && row.playback_state === "idle") {
        await act(async () => {
          panelToggle.click();
        });
      }
      if (row.playback_state === "playing" || row.playback_state === "paused") {
        await act(async () => {
          playToggle.click();
        });
        expect(playToggle.getAttribute("data-playback-state")).toBe("playing");
        if (row.playback_state === "paused") {
          await act(async () => {
            playToggle.click();
          });
          expect(playToggle.getAttribute("data-playback-state")).toBe("paused");
        }
      }

      if (row.action === "play") {
        // Idle or paused: the toggle starts (or resumes) speech and expands the panel.
        await act(async () => {
          playToggle.click();
        });
        expect(playToggle.getAttribute("data-playback-state")).toBe("playing");
        expect(panelToggle.getAttribute("aria-expanded")).toBe("true");
      } else if (row.action === "pause") {
        await act(async () => {
          playToggle.click();
        });
        expect(playToggle.getAttribute("data-playback-state")).toBe("paused");
      } else if (row.action === "speed_change_mid_sentence") {
        const nextExpectedRate = rates[(targetIdx + 1) % rates.length];
        const before = speech!.spoken[speech!.spoken.length - 1];
        await act(async () => {
          speedBtn.click();
        });
        expect(speedBtn.getAttribute("data-rate")).toBe(String(nextExpectedRate));
        const resumed = speech!.spoken[speech!.spoken.length - 1];
        expect(resumed.rate).toBe(nextExpectedRate);
        if (row.boundary_events === "yes") {
          // Resumes at the last word boundary (the second word), never at the sentence start.
          expect(resumed.text).toBe(before.text.slice(before.text.indexOf(" ") + 1));
        } else {
          // No boundary events: the documented fallback restarts the current sentence.
          expect(resumed.text).toBe(before.text);
        }
        expect(playToggle.getAttribute("data-playback-state")).toBe("playing");
      } else if (row.action === "stop") {
        const stopBtn = container.querySelector('[data-testid="read-aloud-stop"]') as HTMLButtonElement;
        expect(stopBtn).not.toBeNull();
        await act(async () => {
          stopBtn.click();
        });
        expect(playToggle.getAttribute("data-playback-state")).toBe("idle");
      } else if (row.action === "toggle_panel") {
        const wasOpen = panelToggle.getAttribute("aria-expanded") === "true";
        await act(async () => {
          panelToggle.click();
        });
        expect(panelToggle.getAttribute("aria-expanded")).toBe(wasOpen ? "false" : "true");
        if (wasOpen) expect(playToggle.getAttribute("data-playback-state")).toBe("idle");
      } else if (row.action === "page_flip") {
        await act(async () => {
          (container!.querySelector('button[aria-label="Next preview page"]') as HTMLButtonElement).click();
        });
        // continue_on_page_turn (default on): playback state survives the turn; playing restarts on the new page.
        expect(playToggle.getAttribute("data-playback-state")).toBe(row.playback_state);
      } else if (row.action === "page_hide") {
        await act(async () => {
          window.dispatchEvent(new Event("pagehide"));
        });
        expect(playToggle.getAttribute("data-playback-state")).toBe("idle");
      }

      // Every utterance in the row uses the voice the registry ranking picks for this browser voice set.
      for (const spoken of speech!.spoken) {
        expect(spoken.voiceName).toBe(EXPECTED_VOICE[row.voice_set]);
      }
    },
  );
});
