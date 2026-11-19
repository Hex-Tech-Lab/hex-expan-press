import { describe, expect, it } from "vitest";
import { anchorPageOf, viewerPageFor } from "../review-anchor";

describe("anchorPageOf", () => {
  it.each([
    [{ page: 12 }, 12],
    [{ touchpoints: [{ page: 7 }] }, 7],
    [{ touchpoints: [{ page: null }], page: 4 }, 4],
    // A non-null but invalid touchpoint must not hide a valid top-level page (review thread, P2).
    [{ touchpoints: [{ page: "seven" }], page: 4 }, 4],
    [{ touchpoints: [{ page: 0 }], page: 9 }, 9],
    [{ touchpoints: [{ page: 2.5 }], page: null }, null],
    [{ touchpoints: [{ page: 6 }], page: 4 }, 6],
    [{ page: null }, null],
    [{ page: 0 }, null],
    [{ page: 2.5 }, null],
    [{ touchpoints: [] }, null],
    [null, null],
    ["page 3", null],
  ])("anchor %j -> %s", (anchor, want) => {
    expect(anchorPageOf(anchor)).toBe(want);
  });
});

describe("viewerPageFor", () => {
  it("opens the anchored page when it is inside the PDF, with no notice", () => {
    expect(viewerPageFor(3, 5, "Q1")).toEqual({ page: 3, notice: null });
    expect(viewerPageFor(5, 5, "Q1")).toEqual({ page: 5, notice: null });
  });

  it("opens page 1 with no notice when the question has no anchor", () => {
    expect(viewerPageFor(null, 5, "Q1")).toEqual({ page: 1, notice: null });
  });

  it("opens page 1 and says so when the anchor is past the last page", () => {
    const view = viewerPageFor(9, 5, "Q7");
    expect(view.page).toBe(1);
    expect(view.notice).toBe("Question Q7 points to PDF page 9, but this PDF has 5 pages. Showing page 1.");
  });

  it.each([0, -2])("opens page 1 and says so for an anchor below the first page (%i)", (anchor) => {
    const view = viewerPageFor(anchor, 5, "Q2");
    expect(view.page).toBe(1);
    expect(view.notice).not.toBeNull();
  });
});
