// @vitest-environment jsdom
// Stepper focus-management regression tests (Wave 83 tactile/a11y): the
// question <h2 id="review-question-text"> must not steal focus on first
// paint, must receive focus after stepper navigation (Back), and heading
// levels must stay intact (one h1, question as h2).
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../actions", () => ({
  submitReviewAnswerAction: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("next/link", () => ({
  default: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement("a", props, props.children),
}));

vi.mock("framer-motion", () => {
  const MOTION_ONLY_PROPS = ["initial", "animate", "exit", "transition", "variants", "whileTap", "whileHover", "layout"];
  const stripMotionProps = (props: Record<string, unknown>) => {
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      if (!MOTION_ONLY_PROPS.includes(key)) rest[key] = props[key];
    }
    return rest;
  };
  const m = new Proxy(
    {},
    {
      get: (_target, tag) => {
        if (typeof tag !== "string") return undefined;
        const Motionless = (props: Record<string, unknown>) => React.createElement(tag, stripMotionProps(props));
        return Motionless;
      },
    },
  );
  return {
    m,
    useReducedMotion: () => true,
    LazyMotion: (props: { children?: React.ReactNode }) => props?.children ?? null,
    domAnimation: {},
  };
});

import ReviewClient from "../review-client";
import type { ReviewItemView } from "../page";

const ITEMS: ReviewItemView[] = [
  { id: "i1", code: "Q1", kind: "confirm", question: "Question one?", options: [], anchorPage: null },
  { id: "i2", code: "Q2", kind: "confirm", question: "Question two?", options: [], anchorPage: null },
  { id: "i3", code: "Q3", kind: "confirm", question: "Question three?", options: [], anchorPage: null },
];

const SAVED = { i1: { choice: "A", freeText: "" } };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderReviewClient(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(ReviewClient, { items: ITEMS, saved: SAVED, pdfUrl: null, bookTitle: "T" }));
  });
}

function questionHeading(): HTMLHeadingElement {
  const h2 = container?.querySelector<HTMLHeadingElement>("#review-question-text");
  if (!h2) throw new Error("#review-question-text not found");
  return h2;
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

describe("review stepper focus management", () => {
  it("initial render: question heading is a focusable h2 and focus() is never called on first load", async () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      await renderReviewClient();

      const h2 = questionHeading();
      expect(h2.tagName).toBe("H2");
      expect(h2.getAttribute("tabindex")).toBe("-1");
      expect(h2.textContent).toBe("Question two?");
      expect(document.activeElement).not.toBe(h2);
      expect(focusSpy).not.toHaveBeenCalled();
    } finally {
      focusSpy.mockRestore();
    }
  });

  it("Back click: question h2 receives focus AND focus() was called with { preventScroll: true }", async () => {
    await renderReviewClient();

    const back = Array.from(container!.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Back"));
    if (!back) throw new Error("Back button not found");

    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      await act(async () => {
        back.click();
      });

      const h2 = questionHeading();
      expect(h2.textContent).toBe("Question one?");
      expect(document.activeElement).toBe(h2);
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      focusSpy.mockRestore();
    }
  });

  it("Save & next succeeds: focus moves to the NEXT question's h2 with preventScroll: true", async () => {
    vi.useFakeTimers();
    const { submitReviewAnswerAction } = await import("../actions");
    vi.mocked(submitReviewAnswerAction).mockResolvedValueOnce({ ok: true });

    try {
      await renderReviewClient();

      const h2Before = questionHeading();
      expect(h2Before.textContent).toBe("Question two?");

      // Provide freeText answer so saveAndNext doesn't bail early on missing input
      const textarea = container!.querySelector<HTMLTextAreaElement>("textarea#freetext");
      if (!textarea) throw new Error("textarea#freetext not found");

      await act(async () => {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        nativeSetter?.call(textarea, "Fact update");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      });

      const saveBtn = Array.from(container!.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Save & next"));
      if (!saveBtn) throw new Error("Save & next button not found");

      const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");

      await act(async () => {
        saveBtn.click();
      });

      // Advance fake timers past the 500ms post-save stepper delay
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      const h2After = questionHeading();
      expect(h2After.textContent).toBe("Question three?");
      expect(document.activeElement).toBe(h2After);
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("Save & next fails: focus stays put and the question does not change", async () => {
    vi.useFakeTimers();
    const { submitReviewAnswerAction } = await import("../actions");
    vi.mocked(submitReviewAnswerAction).mockResolvedValueOnce({ ok: false, error: "Save error" });

    try {
      await renderReviewClient();

      const h2Before = questionHeading();
      expect(h2Before.textContent).toBe("Question two?");

      const textarea = container!.querySelector<HTMLTextAreaElement>("textarea#freetext");
      if (!textarea) throw new Error("textarea#freetext not found");

      await act(async () => {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        nativeSetter?.call(textarea, "Failed attempt");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      });

      const saveBtn = Array.from(container!.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Save & next"));
      if (!saveBtn) throw new Error("Save & next button not found");

      const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");

      await act(async () => {
        saveBtn.click();
      });

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      const h2After = questionHeading();
      expect(h2After.textContent).toBe("Question two?");
      expect(focusSpy).not.toHaveBeenCalled();
      expect(container?.textContent).toContain("Save error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("heading hierarchy: exactly one h1 and the question heading is an h2", async () => {
    await renderReviewClient();

    const h1s = container!.querySelectorAll("h1");
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe("Manuscript review");
    expect(questionHeading().tagName).toBe("H2");
  });
});
