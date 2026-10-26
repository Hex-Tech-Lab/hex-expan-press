import { describe, test, expect } from "vitest";
import { Project } from "ts-morph";
import { SecurityFixWithoutTestRule, NonNullAfterArraySortFilterRule } from "../security-lessons-20260905";

// Unlike scripts/quality-engine/__tests__/wave9-new-rules.test.ts, these tests
// actually invoke `.check()` and assert on the returned findings -- the exact
// gap (tests that assert on raw source text instead of exercising the rule)
// this whole rule set exists to catch.

function makeCtx(project: Project, filePath: string, allFiles: string[]) {
  return {
    filePath,
    ast: project.getSourceFileOrThrow(filePath),
    allFiles,
  };
}

describe("SecurityFixWithoutTestRule", () => {
  test("flags an authorization-marked file with no sibling test in its directory", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "web/lib/usecases/GetUserEntitlementsUseCase.ts",
      `export class GetUserEntitlementsUseCase {
        execute(userId: string) {
          const founderUserIds = (process.env.FOUNDER_USER_IDS ?? '').split(',');
          if (founderUserIds.includes(userId)) return { is_founder: true };
          return { is_founder: false };
        }
      }`,
    );
    const allFiles = ["web/lib/usecases/GetUserEntitlementsUseCase.ts"];
    const findings = SecurityFixWithoutTestRule.check(
      makeCtx(project, "web/lib/usecases/GetUserEntitlementsUseCase.ts", allFiles),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.title).toContain("no sibling test");
  });

  test("does NOT flag when an exact-stem sibling test exists in __tests__", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "web/lib/usecases/GetUserEntitlementsUseCase.ts",
      `export class GetUserEntitlementsUseCase {
        execute(userId: string) { return { is_founder: false }; }
      }`,
    );
    const allFiles = [
      "web/lib/usecases/GetUserEntitlementsUseCase.ts",
      "web/lib/usecases/__tests__/get-user-entitlements.test.ts",
    ];
    const findings = SecurityFixWithoutTestRule.check(
      makeCtx(project, "web/lib/usecases/GetUserEntitlementsUseCase.ts", allFiles),
    );
    expect(findings).toHaveLength(0);
  });

  test("does NOT suppress a finding via an unrelated test with a merely-overlapping name (foo vs foo-admin)", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "web/lib/usecases/Foo.ts",
      `export function foo(u: string) { return u === process.env.FOUNDER_USER_IDS; }`,
    );
    const allFiles = [
      "web/lib/usecases/Foo.ts",
      "web/lib/usecases/__tests__/foo-admin.test.ts",
    ];
    const findings = SecurityFixWithoutTestRule.check(
      makeCtx(project, "web/lib/usecases/Foo.ts", allFiles),
    );
    expect(findings).toHaveLength(1);
  });

  test("does NOT match a same-named file in an unrelated module/directory", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "web/lib/usecases/Foo.ts",
      `export function foo(u: string) { return u === process.env.FOUNDER_USER_IDS; }`,
    );
    const allFiles = [
      "web/lib/usecases/Foo.ts",
      "web/lib/other-module/__tests__/foo.test.ts",
    ];
    const findings = SecurityFixWithoutTestRule.check(
      makeCtx(project, "web/lib/usecases/Foo.ts", allFiles),
    );
    expect(findings).toHaveLength(1);
  });

  test("fires on the case-insensitive 'bypass'/HARDCODED_OWNER marker class (the actual PR #286 bug shape)", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "web/lib/usecases/Owner.ts",
      `const HARDCODED_OWNER_IDS = ['abc-123'];
       export function isOwner(id: string) { return HARDCODED_OWNER_IDS.includes(id); }`,
    );
    const findings = SecurityFixWithoutTestRule.check(
      makeCtx(project, "web/lib/usecases/Owner.ts", ["web/lib/usecases/Owner.ts"]),
    );
    expect(findings).toHaveLength(1);
  });

  test("does not flag a file with no authorization marker at all", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("web/lib/format-date.ts", `export function formatDate(d: Date) { return d.toISOString(); }`);
    const findings = SecurityFixWithoutTestRule.check(
      makeCtx(project, "web/lib/format-date.ts", ["web/lib/format-date.ts"]),
    );
    expect(findings).toHaveLength(0);
  });

  test("emits a low-severity diagnostic (not a silent pass) when allFiles is unavailable", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "web/lib/usecases/GetUserEntitlementsUseCase.ts",
      `export function x() { return process.env.FOUNDER_USER_IDS; }`,
    );
    const findings = SecurityFixWithoutTestRule.check({
      filePath: "web/lib/usecases/GetUserEntitlementsUseCase.ts",
      ast: project.getSourceFileOrThrow("web/lib/usecases/GetUserEntitlementsUseCase.ts"),
      // allFiles intentionally omitted
    } as any);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.title).toContain("cannot verify sibling test");
  });

  test("does not construct an undefined reference in the fix message (regression: stemKebab bug)", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "web/lib/usecases/GetUserEntitlementsUseCase.ts",
      `export function x() { return process.env.FOUNDER_USER_IDS; }`,
    );
    const findings = SecurityFixWithoutTestRule.check(
      makeCtx(project, "web/lib/usecases/GetUserEntitlementsUseCase.ts", [
        "web/lib/usecases/GetUserEntitlementsUseCase.ts",
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.fix).not.toContain("undefined");
    expect(findings[0]!.fix).toContain("get-user-entitlements");
  });
});

describe("NonNullAfterArraySortFilterRule", () => {
  test("flags arr[0]! after a .sort() assignment to the same variable", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "web/lib/pick-best.ts",
      `function pick(rows: {rank: number}[]) {
        let valid = rows;
        valid.sort((a, b) => b.rank - a.rank);
        const best = valid[0]!;
        return best;
      }`,
    );
    const findings = NonNullAfterArraySortFilterRule.check(
      makeCtx(project, "web/lib/pick-best.ts", []),
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]!.severity).toBe("medium");
  });

  test("does not flag a plain array-literal non-null assertion with no sort/filter in scope", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "web/lib/pick-first.ts",
      `function first() {
        const arr = [1, 2, 3];
        const x = arr[0]!;
        return x;
      }`,
    );
    const findings = NonNullAfterArraySortFilterRule.check(
      makeCtx(project, "web/lib/pick-first.ts", []),
    );
    expect(findings).toHaveLength(0);
  });
});
