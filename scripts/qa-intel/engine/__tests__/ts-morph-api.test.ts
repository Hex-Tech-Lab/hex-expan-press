import { describe, expect, test } from "vitest";
import { Project } from "ts-morph";
import { AsyncWithoutAwaitRule, DeadCodeRule } from "../rules/quality";

// Regression tests for ts-morph calls the rules used to make against members that do not exist in ts-morph 28.
// Each rule used to return nothing on these inputs, and no error was shown. The fixtures run in this repo, so the
// rules and the fixtures share one ts-morph instance. A rule that silently finds nothing fails these tests.
function source(code: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("fixture.ts", code);
}

describe("ts-morph API regressions in the copied rules", () => {
  test("DeadCodeRule flags an always-false if (it called IfStatement.getCondition, which does not exist)", () => {
    const findings = DeadCodeRule.check(source("export function f(x: number) {\n  if (false) { return 1; }\n  return x;\n}\n"));
    expect(findings).toHaveLength(1);
  });

  test("AsyncWithoutAwaitRule flags an async function with no await (it read getBody through an any cast)", () => {
    const findings = AsyncWithoutAwaitRule.check(source("export async function f() {\n  return 1;\n}\n"));
    expect(findings.length).toBeGreaterThan(0);
  });

  test("AsyncWithoutAwaitRule stays quiet when an await is present", () => {
    const findings = AsyncWithoutAwaitRule.check(source("export async function f() {\n  await g();\n}\n"));
    expect(findings).toHaveLength(0);
  });
});
