import { describe, expect, it } from "vitest";
import { anchorPageOf } from "../review-anchor";

describe("anchorPageOf", () => {
  it.each([
    [{ page: 12 }, 12],
    [{ touchpoints: [{ page: 7 }] }, 7],
    [{ touchpoints: [{ page: null }], page: 4 }, 4],
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
