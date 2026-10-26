import { describe, test, expect } from "vitest";
import { Project } from "ts-morph";
import * as legacyRules from "../index";
import { SecurityFixWithoutTestRule, NonNullAfterArraySortFilterRule } from "../security-lessons-20260905";

// Review finding (2026-09-07): unit tests for these rules called `.check()`
// directly with a hand-built ctx, which proves the rule LOGIC works but not
// that the production registration path (rules/index.ts's exports, which
// scripts/verify-quality-engine.ts consumes via `Object.values(legacyRules)`)
// actually wires them in, or that ctx.filePath and ctx.allFiles are built the
// same way QualityEngine.analyze() really builds them (both sourced from the
// SAME file array -- `{ filePath: file, ast, allFiles: existing }`,
// application/QualityEngine.ts). A rule can pass every direct-.check() test
// and still be silently absent from the real scan, or silently miswired.

describe("security-lessons-20260905 rules — production registration", () => {
  test("both rules are present in the real Object.values(legacyRules) registration set", () => {
    const registered = Object.values(legacyRules);
    expect(registered).toContain(SecurityFixWithoutTestRule);
    expect(registered).toContain(NonNullAfterArraySortFilterRule);
  });

  test("SecurityFixWithoutTestRule: suppresses when ctx.filePath and ctx.allFiles come from the SAME real file list (the actual QualityEngine.analyze() contract)", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const source = "web/lib/usecases/GetUserEntitlementsUseCase.ts";
    const testFile = "web/lib/usecases/__tests__/get-user-entitlements.test.ts";
    project.createSourceFile(source, `
      export class GetUserEntitlementsUseCase {
        execute(userId: string) {
          if (getUser(userId)) return { founder: true };
        }
      }
    `);
    // Mirrors QualityEngine.analyze(): `existing` (the full scanned file
    // list) is passed as BOTH the source of the current file's ctx.filePath
    // AND ctx.allFiles for every file in one scan.
    const existing = [source, testFile];
    const findings = SecurityFixWithoutTestRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: existing,
    });
    expect(findings).toHaveLength(0);
  });

  test("SecurityFixWithoutTestRule: fires when the same real file list has no sibling test", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const source = "web/lib/usecases/GetUserEntitlementsUseCase.ts";
    project.createSourceFile(source, `
      export class GetUserEntitlementsUseCase {
        execute(userId: string) {
          if (getUser(userId)) return { founder: true };
        }
      }
    `);
    const existing = [source]; // no test file anywhere in this scan
    const findings = SecurityFixWithoutTestRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: existing,
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  test("NonNullAfterArraySortFilterRule: fires under the same real-scan ctx shape", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const source = "web/lib/pick-best.ts";
    project.createSourceFile(source, `function pick(rows: {rank: number}[]) {
      let valid = rows;
      valid.sort((a, b) => b.rank - a.rank);
      return valid[0]!;
    }`);
    const findings = NonNullAfterArraySortFilterRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: [source],
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });
});
