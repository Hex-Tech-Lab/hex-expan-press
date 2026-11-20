// @vitest-environment jsdom
// Regression tests for useReadAloud resume-on-restart (cubic P1, PR #142).
// Chrome keeps speechSynthesis.paused across cancel(); speakFromIndex must
// clear that state before speak(), or the UI shows "playing" with no audio.
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";
import type { ReadAloudChunk } from "../src/components/storefront/book-previewer-text";
import { useReadAloud } from "../src/components/storefront/use-read-aloud";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useReadAloud>;

const chunks: ReadAloudChunk[] = [
  { id: "c0", pageIndex: 0, blockIndex: 0, text: "First sentence." },
  { id: "c1", pageIndex: 0, blockIndex: 1, text: "Second sentence." },
];

const settings = DEFAULT_GLOBAL.book_preview.read_aloud;

let synth: {
  paused: boolean;
  cancel: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  speak: ReturnType<typeof vi.fn>;
};

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

function installSynth() {
  synth = {
    paused: false,
    // Matches Chrome: cancel() drops queued utterances but leaves the paused flag set.
    cancel: vi.fn(),
    pause: vi.fn(() => {
      synth.paused = true;
    }),
    resume: vi.fn(() => {
      synth.paused = false;
    }),
    speak: vi.fn(),
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });
}

describe("useReadAloud resume after pause", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: Hook;
  let onExpand: ReturnType<typeof vi.fn>;

  function Harness() {
    latest = useReadAloud(chunks, settings, () => onExpand());
    return null;
  }

  async function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Harness));
    });
  }

  beforeEach(async () => {
    installSynth();
    onExpand = vi.fn();
    await mount();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("pause -> speed change -> play resumes the engine and speaks", async () => {
    await act(async () => latest.handlePlayPauseResume());
    expect(latest.playbackState).toBe("playing");
    expect(synth.speak).toHaveBeenCalledTimes(1);

    await act(async () => latest.handlePlayPauseResume());
    expect(latest.playbackState).toBe("paused");
    expect(synth.paused).toBe(true);

    await act(async () => latest.handleCycleSpeed());
    const speakCallsBefore = synth.speak.mock.calls.length;
    synth.resume.mockClear();

    await act(async () => latest.handlePlayPauseResume());

    expect(synth.resume).toHaveBeenCalled();
    expect(synth.paused).toBe(false);
    expect(synth.speak.mock.calls.length).toBeGreaterThan(speakCallsBefore);
    expect(latest.playbackState).toBe("playing");
  });

  it("pause -> stop -> play resumes the engine and speaks", async () => {
    await act(async () => latest.handlePlayPauseResume());
    await act(async () => latest.handlePlayPauseResume());
    expect(latest.playbackState).toBe("paused");
    expect(synth.paused).toBe(true);

    await act(async () => latest.stopReadAloud());
    expect(latest.playbackState).toBe("idle");
    // Stop cancels the queue but Chrome keeps the paused flag: the bug condition.
    expect(synth.paused).toBe(true);

    synth.resume.mockClear();
    synth.speak.mockClear();

    await act(async () => latest.handlePlayPauseResume());

    expect(onExpand).toHaveBeenCalledTimes(2);
    expect(synth.resume).toHaveBeenCalled();
    expect(synth.paused).toBe(false);
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(latest.playbackState).toBe("playing");
  });

  it("resume happens after cancel and before speak", async () => {
    await act(async () => latest.handlePlayPauseResume());
    await act(async () => latest.handlePlayPauseResume());
    await act(async () => latest.stopReadAloud());

    const order: string[] = [];
    synth.cancel.mockImplementation(() => order.push("cancel"));
    synth.resume.mockImplementation(() => {
      order.push("resume");
      synth.paused = false;
    });
    synth.speak.mockImplementation(() => order.push("speak"));

    await act(async () => latest.handlePlayPauseResume());

    expect(order).toEqual(["cancel", "resume", "speak"]);
  });
});
