import { describe, it, expect } from "vitest";
import { reviewProgress } from "../progress";

describe("reviewProgress", () => {
  it("counts duplicates once (history rows share item_id)", () => {
    expect(reviewProgress(["a", "b"], ["a", "a", "b", "a"])).toEqual({ answered: 2, total: 2 });
  });

  it("ignores answers for items not in the product's item list", () => {
    expect(reviewProgress(["a", "b"], ["a", "x", "y"])).toEqual({ answered: 1, total: 2 });
  });

  it("returns 0/0 for empty lists", () => {
    expect(reviewProgress([], [])).toEqual({ answered: 0, total: 0 });
    expect(reviewProgress(["a"], [])).toEqual({ answered: 0, total: 1 });
    expect(reviewProgress([], ["a"])).toEqual({ answered: 0, total: 0 });
  });
});
