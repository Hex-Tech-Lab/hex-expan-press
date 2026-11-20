// @vitest-environment jsdom
// useReadAloud engine behaviour against a mocked speechSynthesis: rate change mid-sentence,
// boundary tracking and fallback, highlight advance, voice selection, and Firefox-safe play.
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL, type BookPreviewReadAloudSettings } from "../../payments/src/settings_registry";
import type { ReadAloudChunk } from "../src/components/storefront/book-previewer-text";
import { useReadAloud } from "../src/components/storefront/use-read-aloud";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useReadAloud>;
type VoiceLike = { name: string; lang: string };

const chunks: ReadAloudChunk[] = [
  { id: "c0", pageIndex: 0, blockIndex: 0, text: "The quick brown fox jumps." },
  { id: "c1", pageIndex: 0, blockIndex: 1, text: "Second sentence." },
];
const BROWN = "The quick ".length; // char offset of the word "brown"

const baseSettings = DEFAULT_GLOBAL.book_preview.read_aloud;
const ARIA: VoiceLike = { name: "Microsoft Aria Online (Natural) - English (United States)", lang: "en-US" };
const DAVID: VoiceLike = { name: "Microsoft David - English (United States)", lang: "en-US" };

class FakeUtterance {
  text: string;
  rate = 1;
  voice: VoiceLike | null = null;
  lang = "";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onboundary: ((ev: { charIndex: number }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

let voices: VoiceLike[] = [];
let voiceListeners: Array<() => void> = [];
let synth: {
  paused: boolean;
  speaking: boolean;
  pending: boolean;
  cancel: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  speak: ReturnType<typeof vi.fn>;
  getVoices: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};

function installSynth() {
  voiceListeners = [];
  synth = {
    paused: false,
    speaking: false,
    pending: false,
    // Chrome: cancel() drops the queue and leaves the paused flag set.
    cancel: vi.fn(() => {
      synth.speaking = false;
    }),
    pause: vi.fn(() => {
      synth.paused = true;
    }),
    resume: vi.fn(() => {
      synth.paused = false;
    }),
    speak: vi.fn(() => {
      synth.speaking = true;
    }),
    getVoices: vi.fn(() => voices),
    addEventListener: vi.fn((type: string, cb: () => void) => {
      if (type === "voiceschanged") voiceListeners.push(cb);
    }),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });
}

function lastUtterance(): FakeUtterance {
  const calls = synth.speak.mock.calls;
  return calls[calls.length - 1][0] as FakeUtterance;
}

describe("useReadAloud engine", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: Hook;
  let onExpand: ReturnType<typeof vi.fn>;
  let settings: BookPreviewReadAloudSettings;

  // The chunk set the hook reads. A page turn swaps it, as the previewer does when the spread changes.
  let currentChunks: ReadAloudChunk[] = chunks;

  function Harness() {
    latest = useReadAloud(currentChunks, settings, () => onExpand());
    return null;
  }

  async function turnToChunks(next: ReadAloudChunk[]) {
    currentChunks = next;
    await act(async () => {
      root.render(React.createElement(Harness));
    });
  }

  async function mount(override: Partial<BookPreviewReadAloudSettings> = {}) {
    settings = { ...baseSettings, ...override };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Harness));
    });
  }

  beforeEach(() => {
    voices = [];
    currentChunks = chunks;
    installSynth();
    onExpand = vi.fn();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  describe("rate change mid-sentence (defect 1)", () => {
    it("resumes the rest of the sentence from the last word boundary, not the chunk start", async () => {
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      const first = lastUtterance();
      expect(first.text).toBe(chunks[0].text);
      await act(async () => {
        first.onstart?.();
        first.onboundary?.({ charIndex: BROWN });
      });

      await act(async () => latest.handleCycleSpeed());

      expect(synth.cancel).toHaveBeenCalled();
      const resumed = lastUtterance();
      expect(resumed).not.toBe(first);
      expect(resumed.text).toBe("brown fox jumps.");
      expect(resumed.rate).toBe(1.25);
      expect(latest.playbackState).toBe("playing");
    });

    it("ignores the cancelled utterance's late onend (no double advance)", async () => {
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      const first = lastUtterance();
      await act(async () => first.onboundary?.({ charIndex: BROWN }));
      await act(async () => latest.handleCycleSpeed());
      const spokenBefore = synth.speak.mock.calls.length;

      await act(async () => first.onend?.());

      expect(synth.speak.mock.calls.length).toBe(spokenBefore);
    });

    it("after the resumed remainder ends, speaks the next sentence at the new rate", async () => {
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      const first = lastUtterance();
      await act(async () => first.onboundary?.({ charIndex: BROWN }));
      await act(async () => latest.handleCycleSpeed());
      const resumed = lastUtterance();

      await act(async () => resumed.onend?.());

      expect(lastUtterance().text).toBe("Second sentence.");
      expect(lastUtterance().rate).toBe(1.25);
      expect(latest.activeChunkId).toBe("c1");
    });

    it("no-boundary fallback: restarts the current sentence from its start", async () => {
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      const first = lastUtterance();
      await act(async () => first.onstart?.());

      await act(async () => latest.handleCycleSpeed());

      expect(lastUtterance().text).toBe(chunks[0].text);
      expect(lastUtterance().rate).toBe(1.25);
    });

    it("speed change while paused resumes from the last boundary when play is pressed", async () => {
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      await act(async () => lastUtterance().onboundary?.({ charIndex: BROWN }));
      await act(async () => latest.handlePlayPauseResume());
      expect(latest.playbackState).toBe("paused");

      await act(async () => latest.handleCycleSpeed());
      synth.resume.mockClear();
      await act(async () => latest.handlePlayPauseResume());

      expect(synth.resume).toHaveBeenCalled();
      expect(lastUtterance().text).toBe("brown fox jumps.");
      expect(lastUtterance().rate).toBe(1.25);
    });
  });

  describe("highlight accuracy (defect 4)", () => {
    it("sentence highlight advances on onstart and onend, per chunk", async () => {
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      const first = lastUtterance();
      await act(async () => first.onstart?.());
      expect(latest.activeChunkId).toBe("c0");

      await act(async () => first.onend?.());
      expect(latest.activeChunkId).toBe("c1");
      const second = lastUtterance();
      await act(async () => second.onstart?.());
      expect(latest.activeChunkId).toBe("c1");

      await act(async () => second.onend?.());
      expect(latest.playbackState).toBe("idle");
      expect(latest.activeChunkId).toBeNull();
    });

    it("word highlight is off by default: boundary events leave activeWord null", async () => {
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      await act(async () => lastUtterance().onboundary?.({ charIndex: BROWN }));
      expect(latest.activeWord).toBeNull();
    });

    it("word highlight on (registry flag): activeWord is the word at the boundary", async () => {
      await mount({ highlight_words: true });
      await act(async () => latest.handlePlayPauseResume());
      await act(async () => lastUtterance().onboundary?.({ charIndex: BROWN }));
      expect(latest.activeWord).toEqual({ chunkId: "c0", start: BROWN, end: BROWN + "brown".length });
    });
  });

  describe("voices and first-click play (defects 2 and 3)", () => {
    it("with voices already loaded, speaks with the ranked voice", async () => {
      voices = [DAVID, ARIA];
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      expect(lastUtterance().voice).toEqual(ARIA);
      expect(lastUtterance().lang).toBe("en-US");
    });

    it("voices arriving late via voiceschanged are used by the next utterance", async () => {
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      expect(lastUtterance().voice).toBeNull();
      await act(async () => latest.stopReadAloud());

      voices = [DAVID, ARIA];
      await act(async () => voiceListeners.forEach((cb) => cb()));
      await act(async () => latest.handlePlayPauseResume());

      expect(lastUtterance().voice).toEqual(ARIA);
    });

    it("first-click play calls speak synchronously, with the default voice when none are loaded", async () => {
      await mount();
      let spokenInsideClick = -1;
      await act(async () => {
        latest.handlePlayPauseResume();
        // Checked before act() returns: speak() must not wait on any async step.
        spokenInsideClick = synth.speak.mock.calls.length;
      });
      expect(spokenInsideClick).toBe(1);
      expect(lastUtterance().voice).toBeNull();
      expect(latest.playbackState).toBe("playing");
    });

    it("Firefox guard: play on an idle engine does not call cancel() before speak()", async () => {
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      expect(synth.cancel).not.toHaveBeenCalled();
      expect(synth.speak).toHaveBeenCalledTimes(1);
    });

    it("Firefox guard: cancel() is still issued when speech is queued", async () => {
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      synth.cancel.mockClear();
      await act(async () => latest.handleCycleSpeed());
      expect(synth.cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("page turn during playback (continue_on_page_turn)", () => {
    const nextPage: ReadAloudChunk[] = [
      { id: "p1-b0-s0", pageIndex: 1, blockIndex: 0, text: "Next page opens here." },
      { id: "p1-b0-s1", pageIndex: 1, blockIndex: 0, text: "More on this page." },
    ];

    it("play -> page change -> speaks the first chunk of the new page at the current rate", async () => {
      await mount();
      await act(async () => latest.handleCycleSpeed());
      await act(async () => latest.handlePlayPauseResume());
      expect(lastUtterance().text).toBe(chunks[0].text);

      await turnToChunks(nextPage);

      expect(lastUtterance().text).toBe("Next page opens here.");
      expect(lastUtterance().rate).toBe(1.25);
      expect(latest.playbackState).toBe("playing");
      expect(latest.activeChunkId).toBe("p1-b0-s0");
    });

    it("paused -> page change -> stays paused; resume starts at the top of the new page", async () => {
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      await act(async () => lastUtterance().onboundary?.({ charIndex: 10 }));
      await act(async () => latest.handlePlayPauseResume());
      expect(latest.playbackState).toBe("paused");
      const spokenBefore = synth.speak.mock.calls.length;

      await turnToChunks(nextPage);

      expect(latest.playbackState).toBe("paused");
      expect(synth.speak.mock.calls.length).toBe(spokenBefore);

      await act(async () => latest.handlePlayPauseResume());

      expect(latest.playbackState).toBe("playing");
      expect(lastUtterance().text).toBe("Next page opens here.");
    });

    it("idle -> page change -> nothing is spoken", async () => {
      await mount();
      await turnToChunks(nextPage);
      expect(synth.speak).not.toHaveBeenCalled();
      expect(latest.playbackState).toBe("idle");
    });

    it("flag off: the hook does not restart on a page change (the previewer stops playback instead)", async () => {
      await mount({ continue_on_page_turn: false });
      await act(async () => latest.handlePlayPauseResume());
      const spokenBefore = synth.speak.mock.calls.length;

      await turnToChunks(nextPage);

      expect(synth.speak.mock.calls.length).toBe(spokenBefore);
      expect(latest.playbackState).toBe("playing");
    });
  });

  describe("PICT page turn x playback state (docs/testing/pairwise/read_aloud_page_turn.model.txt)", () => {
    const REPO_ROOT = existsSync(join(process.cwd(), "docs/testing/pairwise")) ? process.cwd() : resolve(process.cwd(), "..");
    const MODEL = join(REPO_ROOT, "docs/testing/pairwise/read_aloud_page_turn.model.txt");
    const ROWS = join(REPO_ROOT, "docs/testing/pairwise/read_aloud_page_turn.rows.tsv");
    const PAGE_TURN_CHUNKS: Record<string, ReadAloudChunk[]> = {
      none: chunks,
      next: [
        { id: "p1-b0-s0", pageIndex: 1, blockIndex: 0, text: "Next page opens here." },
        { id: "p1-b0-s1", pageIndex: 1, blockIndex: 0, text: "More on this page." },
      ],
      prev: [{ id: "p0-b0-s0", pageIndex: 0, blockIndex: 0, text: "Previous page text." }],
      jump: [{ id: "p4-b0-s0", pageIndex: 4, blockIndex: 0, text: "Jumped to page five." }],
    };

    it("checked-in rows match /usr/local/bin/pict output (no model drift)", () => {
      if (!existsSync("/usr/local/bin/pict")) {
        if (process.env.CI) throw new Error("pict binary missing at /usr/local/bin/pict");
        return;
      }
      const generated = execFileSync("/usr/local/bin/pict", [MODEL], { encoding: "utf8" }).trim();
      expect(generated).toBe(readFileSync(ROWS, "utf8").trim());
    });

    const rows = readFileSync(ROWS, "utf8").trim().split(/\r?\n/).slice(1).map((line) => {
      const [pageTurn, playback] = line.split("\t");
      return { pageTurn, playback };
    });

    it.each(rows)("page turn $pageTurn while $playback: continue from the new page's top (or stay paused)", async ({ pageTurn, playback }) => {
      await mount();
      await act(async () => latest.handlePlayPauseResume());
      if (playback === "paused") await act(async () => latest.handlePlayPauseResume());
      const spokenBefore = synth.speak.mock.calls.length;

      await turnToChunks(PAGE_TURN_CHUNKS[pageTurn]);

      if (pageTurn === "none") {
        expect(synth.speak.mock.calls.length).toBe(spokenBefore);
      }
      if (playback === "playing") {
        expect(latest.playbackState).toBe("playing");
        if (pageTurn !== "none") expect(lastUtterance().text).toBe(PAGE_TURN_CHUNKS[pageTurn][0].text);
      } else {
        expect(latest.playbackState).toBe("paused");
        expect(synth.speak.mock.calls.length).toBe(spokenBefore);
        await act(async () => latest.handlePlayPauseResume());
        expect(latest.playbackState).toBe("playing");
        expect(lastUtterance().text).toBe(PAGE_TURN_CHUNKS[pageTurn][0].text);
      }
    });
  });
});
