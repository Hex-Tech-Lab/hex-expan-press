import { describe, expect, test } from "vitest";
import { newFindingsAgainstBaseline } from "../compare";

const f = (file: string, title: string, extra = "") => ({ file, title, why: extra });

describe("newFindingsAgainstBaseline", () => {
  test("a scan that matches the baseline has no new findings", () => {
    const baseline = [f("a.ts", "T1"), f("b.ts", "T2")];
    expect(newFindingsAgainstBaseline([f("b.ts", "T2"), f("a.ts", "T1")], baseline)).toEqual([]);
  });

  test("a finding with a new (file, title) key is new", () => {
    expect(newFindingsAgainstBaseline([f("a.ts", "T1"), f("a.ts", "T2")], [f("a.ts", "T1")])).toEqual([f("a.ts", "T2")]);
  });

  // R7: one baseline entry accounts for one copy, not every copy of the same (file, title).
  test("baseline has one copy, the scan has two: the second copy is new", () => {
    const scan = [f("a.ts", "T1", "first"), f("a.ts", "T1", "second")];
    expect(newFindingsAgainstBaseline(scan, [f("a.ts", "T1")])).toEqual([f("a.ts", "T1", "second")]);
  });

  test("two baseline copies cover two scan copies", () => {
    expect(newFindingsAgainstBaseline([f("a.ts", "T1"), f("a.ts", "T1")], [f("a.ts", "T1"), f("a.ts", "T1")])).toEqual([]);
  });

  test("fewer copies than the baseline is not a failure", () => {
    expect(newFindingsAgainstBaseline([f("a.ts", "T1")], [f("a.ts", "T1"), f("a.ts", "T1")])).toEqual([]);
  });

  test("the key separates file and title, so a colon inside either cannot collide", () => {
    expect(newFindingsAgainstBaseline([f("a.ts:x", "T")], [f("a.ts", "x:T")])).toEqual([f("a.ts:x", "T")]);
  });
});
