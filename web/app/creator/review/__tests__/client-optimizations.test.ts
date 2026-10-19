// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const submitMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock("../actions", () => ({
  submitReviewAnswerAction: (...args: unknown[]) => submitMock(...args),
}));

vi.mock("next/link", () => ({
  default: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement("a", props, props.children),
}));

vi.mock("framer-motion", () => {
  const stripMotionProps = (props: Record<string, unknown>) => {
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      if (!["initial", "animate", "exit", "transition", "variants", "whileTap", "whileHover", "layout"].includes(key)) {
        rest[key] = props[key];
      }
    }
    return rest;
  };
  const m = new Proxy(
    {},
    {
      get: (_target, tag) => {
        if (typeof tag !== "string") return undefined;
        return (props: Record<string, unknown>) => React.createElement(tag, stripMotionProps(props));
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
  {
    id: "item-1",
    code: "Q1",
    kind: "confirm",
    question: "Question 1?",
    options: [
      { key: "A", label: "Option A" },
      { key: "B", label: "Option B" },
    ],
    anchorPage: null,
  },
  {
    id: "item-2",
    code: "Q2",
    kind: "confirm",
    question: "Question 2?",
    options: [
      { key: "X", label: "Option X" },
      { key: "Y", label: "Option Y" },
    ],
    anchorPage: null,
  },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderClient(saved: Record<string, { choice: string | null; freeText: string | null }> = {}): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(ReviewClient, { items: ITEMS, saved, pdfUrl: null, bookTitle: "Test Book" }));
  });
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
  submitMock.mockClear();
});

describe("ReviewClient zero-egress and double-click optimizations (Task 4)", () => {
  beforeEach(() => {
    submitMock.mockClear();
  });

  it("skips submitReviewAnswerAction network call if answer is unchanged (zero egress)", async () => {
    await renderClient({
      "item-1": { choice: "A", freeText: "" },
    });

    const buttons = container?.querySelectorAll("button") ?? [];
    const saveBtn = Array.from(buttons).find((b) => b.textContent?.includes("Save & next"));
    expect(saveBtn).toBeDefined();

    await act(async () => {
      saveBtn!.click();
    });

    // submitReviewAnswerAction was NOT called! Zero network egress!
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("calls submitReviewAnswerAction when answer has changed", async () => {
    await renderClient({});

    const radioB = container?.querySelector<HTMLInputElement>('input[value="B"]');
    expect(radioB).not.toBeNull();

    await act(async () => {
      radioB!.click();
    });

    const saveBtn = Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Save & next"),
    );
    expect(saveBtn).toBeDefined();

    await act(async () => {
      saveBtn!.click();
    });

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock).toHaveBeenCalledWith("item-1", "B", null);
  });
});
