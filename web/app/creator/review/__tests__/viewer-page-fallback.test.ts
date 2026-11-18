// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The PDF viewer must always land on a real page. An anchor that is missing or outside the loaded
// document used to leave page at 0, and the render effect exits on !page, so the creator saw a blank PDF.
const getPageMock = vi.hoisted(() => vi.fn());
const NUM_PAGES = 5;

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: NUM_PAGES,
      getPage: getPageMock,
    }),
  }),
}));

vi.mock("../actions", () => ({ submitReviewAnswerAction: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("next/link", async () => (await import("./test-helpers")).mockNextLink());
vi.mock("framer-motion", async () => (await import("./test-helpers")).mockFramerMotion());

import ReviewClient from "../review-client";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function item(id: string, anchorPage: number | null) {
  return { id, code: id.toUpperCase(), kind: "confirm", question: `Question ${id}?`, options: [], anchorPage };
}

async function renderWith(anchorPage: number | null): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      React.createElement(ReviewClient, {
        items: [item("q1", anchorPage)],
        saved: {},
        pdfUrl: "https://example.test/book.pdf",
        bookTitle: "Test Book",
      }),
    );
  });
  // Let the document promise resolve and the effects run.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  getPageMock.mockReset();
  getPageMock.mockImplementation(async () => ({
    getViewport: () => ({ width: 100, height: 100 }),
    render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
    getTextContent: async () => ({ items: [] }),
  }));
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
});

describe("review viewer opens on a real page", () => {
  it("opens the anchored page when the anchor is inside the document", async () => {
    await renderWith(3);
    const requested = getPageMock.mock.calls.map((c) => c[0]);
    expect(requested).toContain(3);
    expect(requested).not.toContain(0);
  });

  it("falls back to page 1 when the question has no anchor", async () => {
    await renderWith(null);
    const requested = getPageMock.mock.calls.map((c) => c[0]);
    expect(requested).toContain(1);
    expect(requested).not.toContain(0);
  });

  it("falls back to page 1 when the anchor is past the last page", async () => {
    await renderWith(NUM_PAGES + 4);
    const requested = getPageMock.mock.calls.map((c) => c[0]);
    expect(requested).toContain(1);
    expect(requested).not.toContain(NUM_PAGES + 4);
    expect(requested).not.toContain(0);
  });

  it("tells the creator when the anchor is past the last page (visible, not silent)", async () => {
    await renderWith(NUM_PAGES + 4);
    const notice = container?.querySelector('[role="status"]')?.textContent ?? "";
    expect(notice).toBe(`Question Q1 points to PDF page ${NUM_PAGES + 4}, but this PDF has ${NUM_PAGES} pages. Showing page 1.`);
  });

  it("shows no notice when the anchor is inside the document", async () => {
    await renderWith(3);
    expect(container?.querySelector('[role="status"]')).toBeNull();
  });
});
