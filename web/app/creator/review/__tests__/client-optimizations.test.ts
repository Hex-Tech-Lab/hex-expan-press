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

vi.mock("next/link", async () => (await import("./test-helpers")).mockNextLink());
vi.mock("framer-motion", async () => (await import("./test-helpers")).mockFramerMotion());

import ReviewClient from "../review-client";
import { TEST_REVIEW_ITEMS } from "./test-helpers";

const ITEMS = TEST_REVIEW_ITEMS;

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

describe("ReviewClient zero-egress, busy guard, and draft optimizations", () => {
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

  it("normalizes empty string vs null in unchanged-answer check (zero egress)", async () => {
    // Saved has choice "A" and freeText null; UI freeText defaults to ""
    await renderClient({
      "item-1": { choice: "A", freeText: null },
    });

    const saveBtn = Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Save & next"),
    );
    expect(saveBtn).toBeDefined();

    await act(async () => {
      saveBtn!.click();
    });

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

  it("guards against double-click submission via synchronous busyRef (called once)", async () => {
    let resolveSubmit!: (val: { ok: boolean }) => void;
    submitMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );

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

    // Trigger rapid double-click synchronously inside act()
    await act(async () => {
      saveBtn!.click();
      saveBtn!.click();
    });

    // Resolve the in-flight network call
    await act(async () => {
      resolveSubmit({ ok: true });
    });

    // Even with rapid double-clicking, submitReviewAnswerAction was only invoked ONCE!
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it("keeps busy active during delayed navigation, disabling the Back button", async () => {
    vi.useFakeTimers();
    try {
      // item-1 already answered, item-2 is current question (index 1), so Back button is not disabled by index 0
      await renderClient({
        "item-1": { choice: "A", freeText: "Done" },
      });

      const radioY = container?.querySelector<HTMLInputElement>('input[value="Y"]');
      expect(radioY).not.toBeNull();

      await act(async () => {
        radioY!.click();
      });

      const saveBtn = Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
        b.textContent?.includes("Save & next"),
      );
      const backBtn = Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
        b.textContent?.includes("Back"),
      );
      expect(backBtn).toBeDefined();
      expect(backBtn!.disabled).toBe(false);

      // Trigger save
      await act(async () => {
        saveBtn!.click();
      });

      // During the delayed navigation (before 500ms timeout fires), Back button is disabled because busy is active
      const backBtnDuringDelay = Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
        b.textContent?.includes("Back"),
      );
      expect(backBtnDuringDelay).toBeDefined();
      expect(backBtnDuringDelay!.disabled).toBe(true);

      // Advance timers past delayed navigation
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prevents showItem from restoring a stale draft after saveAndNext succeeds", async () => {
    vi.useFakeTimers();
    try {
      await renderClient({});

      // Question 1: choose option B and save
      const radioB = container?.querySelector<HTMLInputElement>('input[value="B"]');
      await act(async () => {
        radioB!.click();
      });

      const saveBtn = Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
        b.textContent?.includes("Save & next"),
      );
      await act(async () => {
        saveBtn!.click();
      });

      // Advance past the 500ms navigation timer to Question 2
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      // Question 2 heading should now be displayed
      const h2 = container?.querySelector("#review-question-text");
      expect(h2?.textContent).toBe("Question 2?");

      // Click Back to return to Question 1
      const backBtn = Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
        b.textContent?.includes("Back"),
      );
      await act(async () => {
        backBtn!.click();
      });

      // Verify that Question 1 loads its saved state ("B") and not an empty or stale draft
      const radioBAfterBack = container?.querySelector<HTMLInputElement>('input[value="B"]');
      expect(radioBAfterBack?.checked).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
