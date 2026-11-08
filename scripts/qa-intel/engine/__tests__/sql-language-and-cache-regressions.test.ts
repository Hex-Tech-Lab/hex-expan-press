import { Project, type SourceFile } from "ts-morph";
import { describe, expect, test } from "vitest";
import { QualityEngine } from "../application/QualityEngine";
import { wrapLegacyRule } from "../infra/LegacyRuleAdapter";
import { DatabaseConstraintRule, DefaultValueConsistencyRule } from "../rules/data-integrity";

// Regression tests for PR 129 review thread cubic #71 (legacy rules dropped `languages`, so SQL-aware
// rules never ran on migrations). The cache queuing tests for cubic #70 live in scripts/qa-intel/__tests__/cache.test.ts, which the coverage gate runs.

function source(code: string, path: string): SourceFile {
  return new Project({ useInMemoryFileSystem: true }).createSourceFile(path, code);
}

function makeEngine(rules: unknown[], files: Record<string, string>) {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [p, c] of Object.entries(files)) project.createSourceFile(p, c, { overwrite: true });
  const loader = {
    load: async (p: string) => project.getSourceFileOrThrow(p),
    loadFromText: async (p: string, t: string) => project.createSourceFile(p, t, { overwrite: true }),
    getImports: () => [] as string[],
  };
  const fs = { exists: (p: string) => !!project.getSourceFile(p), resolve: (p: string) => p };
  return new QualityEngine(rules as never, loader as never, undefined, fs as never, {
    mode: "full",
    defaultScope: "file",
    concurrency: 1,
  } as never);
}

describe("legacy adapter forwards languages (cubic P1 #71)", () => {
  test("a declared language list reaches the wrapped rule", () => {
    expect(wrapLegacyRule({ name: "x", languages: ["sql"], check: () => [] }).languages).toEqual(["sql"]);
  });

  test("an undeclared language list stays undefined, so the engine default (ts) still applies", () => {
    expect(wrapLegacyRule({ name: "y", check: () => [] }).languages).toBeUndefined();
  });
});

describe("the SQL-aware rules declare sql and fire on migration text (cubic P1 #71)", () => {
  test("both rules accept sql", () => {
    expect(DatabaseConstraintRule.languages).toEqual(["ts", "sql"]);
    expect(DefaultValueConsistencyRule.languages).toEqual(["ts", "sql"]);
  });

  test("DatabaseConstraintRule reports an unconstrained NUMERIC column in a migration", () => {
    const sf = source("CREATE TABLE payments (amount NUMERIC, id INT);", "supabase/migrations/20261107_p.sql");
    expect(DatabaseConstraintRule.check(sf).length).toBeGreaterThan(0);
  });
});

describe("the engine gate runs a sql rule on a migration and keeps a ts-only rule off it", () => {
  test("only the rule that declares sql runs on a .sql file", async () => {
    const sqlOnly = {
      name: "sql-only",
      languages: ["sql"],
      check: (ctx: { filePath: string }) => [
        { file: ctx.filePath, severity: "low", title: "sql-only hit", why: "w", fix: "f" },
      ],
    };
    const tsDefault = {
      name: "ts-default",
      check: (ctx: { filePath: string }) => [
        { file: ctx.filePath, severity: "low", title: "ts-default hit", why: "w", fix: "f" },
      ],
    };
    const engine = makeEngine([sqlOnly, tsDefault], {
      "supabase/migrations/20261107000000_x.sql": "create table t (id int);\n",
    });
    const findings = await engine.analyze(["supabase/migrations/20261107000000_x.sql"]);
    expect(findings.map((f) => f.title)).toEqual(["sql-only hit"]);
    expect(engine.ruleErrors).toEqual([]);
  });
});
