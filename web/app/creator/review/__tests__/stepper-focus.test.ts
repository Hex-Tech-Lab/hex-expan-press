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
  it("initial render: question heading is a focusable h2 but does not steal focus on first load", async () => {
    await renderReviewClient();

    const h2 = questionHeading();
    expect(h2.tagName).toBe("H2");
    expect(h2.getAttribute("tabindex")).toBe("-1");
    expect(h2.textContent).toBe("Question two?");
    expect(document.activeElement).not.toBe(h2);
  });

  it("Back click: shows the previous question and moves focus to it", async () => {
    await renderReviewClient();

    const back = Array.from(container!.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Back"));
    if (!back) throw new Error("Back button not found");

    await act(async () => {
      back.click();
    });

    const h2 = questionHeading();
    expect(h2.textContent).toBe("Question one?");
    expect(document.activeElement).toBe(h2);
  });

  it("heading hierarchy: exactly one h1 and the question heading is an h2", async () => {
    await renderReviewClient();

    const h1s = container!.querySelectorAll("h1");
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe("Manuscript review");
    expect(questionHeading().tagName).toBe("H2");
  });
});
