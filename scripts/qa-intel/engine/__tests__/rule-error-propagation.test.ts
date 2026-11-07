import { describe, expect, test, vi } from "vitest";
import { Project } from "ts-morph";
import { QualityEngine } from "../application/QualityEngine";

// A rule that throws must not vanish. The engine records it as a rule error, and the runner hard-fails on
// rule errors. These tests pin that path, so no rule can swallow an exception and report a clean run.

function makeEngine(rules: unknown[], files: Record<string, string>) {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [p, c] of Object.entries(files)) project.createSourceFile(p, c, { overwrite: true });
  const loader = {
    load: async (p: string) => project.getSourceFile(p)!,
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

describe("rule exceptions are recorded, not swallowed", () => {
  test("a throwing rule becomes a rule error and the run still returns other rules' findings", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const broken = {
      name: "always-throws",
      check: () => {
        throw new TypeError("ts-morph method is missing");
      },
    };
    const healthy = {
      name: "always-finds",
      check: (ctx: { filePath: string }) => [
        { file: ctx.filePath, severity: "low", title: "Test: finding", why: "w", fix: "f" },
      ],
    };
    const engine = makeEngine([broken, healthy], { "src/a.ts": "export const a = 1;" });

    const findings = await engine.analyze(["src/a.ts"]);

    expect(engine.ruleErrors).toHaveLength(1);
    expect(engine.ruleErrors[0]).toMatchObject({
      ruleName: "always-throws",
      filePath: "src/a.ts",
      message: "ts-morph method is missing",
    });
    expect(findings.map((f) => f.title)).toEqual(["Test: finding"]);
    vi.restoreAllMocks();
  });

  test("a clean run records no rule errors", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const engine = makeEngine([{ name: "quiet", check: () => [] }], { "src/b.ts": "export const b = 2;" });
    await engine.analyze(["src/b.ts"]);
    expect(engine.ruleErrors).toEqual([]);
    vi.restoreAllMocks();
  });
});
