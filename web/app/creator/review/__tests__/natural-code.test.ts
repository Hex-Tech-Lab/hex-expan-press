import { describe, it, expect } from "vitest";
import { naturalCode } from "../../../../src/lib/natural-code";

describe("naturalCode comparator (P3 natural-sort drift fix)", () => {
  it("sorts 'A' before 'A1' deterministically", () => {
    expect(naturalCode("A", "A1")).toBeLessThan(0);
    expect(naturalCode("A1", "A")).toBeGreaterThan(0);
    expect(naturalCode("A", "A")).toBe(0);
  });

  it("sorts Q1, Q2, Q10 deterministically without numeric/string drift", () => {
    const list = ["Q10", "Q2", "Q1"];
    list.sort(naturalCode);
    expect(list).toEqual(["Q1", "Q2", "Q10"]);
  });

  it("handles mixed alphanumeric prefix blocks consistently", () => {
    const list = ["B10", "A1", "B2", "A", "B1", "Q2", "Q10", "Q1"];
    list.sort(naturalCode);
    expect(list).toEqual(["A", "A1", "B1", "B2", "B10", "Q1", "Q2", "Q10"]);
  });
});
