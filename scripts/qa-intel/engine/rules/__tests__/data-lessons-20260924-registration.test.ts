import { describe, test, expect } from "vitest";
import { Project } from "ts-morph";
import * as legacyRules from "../index";
import { JsonbReadModifyWriteRule, UntrustedLogInterpolationRule, ConflictMarkerRule } from "../data-lessons-20260924";

// Same rationale as the 2026-09-05 registration test: direct-.check() unit
// tests prove rule logic but not that the production registration path
// (rules/index.ts exports -> scripts/verify-quality-engine.ts's
// Object.values(legacyRules)) actually wires the rules into the real scan.

describe("data-lessons-20260924 rules — production registration", () => {
  test("all three rules are present in the real Object.values(legacyRules) registration set", () => {
    const registered = Object.values(legacyRules);
    expect(registered).toContain(JsonbReadModifyWriteRule);
    expect(registered).toContain(UntrustedLogInterpolationRule);
    expect(registered).toContain(ConflictMarkerRule);
  });

  test("verify-quality-engine.ts dispatch logic routes each rule as the new Rule format (scope defined), not a wrapped legacy IRule", () => {
    for (const rule of [JsonbReadModifyWriteRule, UntrustedLogInterpolationRule, ConflictMarkerRule]) {
      expect((rule as { scope?: string }).scope).toBe("file");
      expect(typeof rule.check).toBe("function");
    }
  });

  test("ConflictMarkerRule fires end-to-end through the same ctx shape QualityEngine.analyze() builds", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const source = "docs/agent-prompts/2026-09-24-oc-b-chapter-persist.md";
    project.createSourceFile(source, "<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> origin/main\n");
    // Mirrors QualityEngine.analyze(): `{ filePath: file, ast, allFiles: existing }`
    const existing = [source];
    const findings = ConflictMarkerRule.check({
      filePath: source,
      ast: project.getSourceFileOrThrow(source),
      allFiles: existing,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
  });
});
