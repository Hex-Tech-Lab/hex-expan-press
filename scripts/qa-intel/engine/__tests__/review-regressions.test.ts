import { Project, type SourceFile } from "ts-morph";
import { describe, expect, test } from "vitest";
import * as rules from "../rules";
import { UnregisteredRuleExportRule } from "../rules/quality";
import { JsonbReadModifyWriteRule } from "../rules/data-lessons-20260924";

// Regression tests for PR 129 review threads on the qa-intel rule set.

function source(code: string, path: string): SourceFile {
  return new Project({ useInMemoryFileSystem: true }).createSourceFile(path, code);
}

describe("Wave 10 rules are exported and so loaded by the runner (cubic P1 #02, CodeRabbit #72)", () => {
  test.each(["ErrorNormalizationRule", "NumberCoercionGuardRule", "UnregisteredRuleExportRule"])(
    "%s is exported from rules/index",
    (name) => {
      const exported = (rules as Record<string, unknown>)[name];
      expect(exported).toBeDefined();
      expect(typeof (exported as { check?: unknown }).check).toBe("function");
    },
  );
});

describe("UnregisteredRuleExportRule audits this port's rule files (cubic P1 #05)", () => {
  const code = `
    import type { IRule } from "../engine";
    export const OrphanRule: IRule = { name: "orphan", check: () => [] };
    export function registerQualityRules(engine: unknown) {
      const e = engine as any;
      e.addRule(undefined);
    }
  `;

  test("flags an exported rule that no register function adds, under scripts/qa-intel/engine/rules", () => {
    const findings = UnregisteredRuleExportRule.check(source(code, "scripts/qa-intel/engine/rules/quality.ts"));
    expect(findings.some((f) => f.title.includes("'OrphanRule'"))).toBe(true);
  });

  test("also audits a relative path, not only an absolute one", () => {
    const findings = UnregisteredRuleExportRule.check(source(code, "scripts/qa-intel/engine/rules/x.ts"));
    expect(findings.length).toBeGreaterThan(0);
  });

  test("the old scripts/quality-engine path no longer silences the rule for this port (regression)", () => {
    // Before the fix, a file under the port's real path was skipped entirely, so this returned [].
    const findings = UnregisteredRuleExportRule.check(source(code, "/work/repo/scripts/qa-intel/engine/rules/y.ts"));
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe("JSONB spread rule judges a parenthesised spread (cubic P1 #09)", () => {
  test("a bare ...(payload || {}) in an update object literal is flagged", () => {
    const code = `
      export async function save(supabase: any, id: string, payload: any) {
        await supabase.from("analyses").update({ ...(payload || {}), status: "done" }).eq("id", id);
      }
    `;
    const findings = JsonbReadModifyWriteRule.check({
      ast: source(code, "web/app/save.ts"),
      filePath: "web/app/save.ts",
    } as never);
    expect(findings.length).toBe(1);
  });

  test("a parenthesised fresh conditional spread is still not flagged (negative control)", () => {
    const code = `
      export async function save(supabase: any, id: string, p: any) {
        await supabase.from("analyses").update({ ...(p.x ? { x: p.x } : {}) }).eq("id", id);
      }
    `;
    const findings = JsonbReadModifyWriteRule.check({
      ast: source(code, "web/app/save.ts"),
      filePath: "web/app/save.ts",
    } as never);
    expect(findings).toEqual([]);
  });
});
