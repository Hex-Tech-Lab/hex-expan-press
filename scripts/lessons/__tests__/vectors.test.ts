import { describe, expect, test } from "vitest";
import { classifyVector, vectorScores } from "../vectors";

describe("classifyVector", () => {
  test("a regex bypass that also names a secret classifies as V2 (two hits beat one)", () => {
    expect(classifyVector("This regex bypass lets the secret through")).toBe("V2");
  });

  test("text with no keyword hit classifies as new", () => {
    expect(classifyVector("looks fine to me")).toBe("new");
  });

  test("a tie goes to the lower vector number", () => {
    // one V1 hit ("readme") and one V3 hit ("silent")
    expect(classifyVector("readme silent")).toBe("V1");
  });
});

describe("vectorScores", () => {
  test("reports every vector and new, all zero when nothing matches", () => {
    const scores = vectorScores("nothing relevant here");
    expect(Object.keys(scores).sort()).toEqual(
      ["new", "V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10"].sort(),
    );
    expect(Object.values(scores).every((n) => n === 0)).toBe(true);
  });
});
