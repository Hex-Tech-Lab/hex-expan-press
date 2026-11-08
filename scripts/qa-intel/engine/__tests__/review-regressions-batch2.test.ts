import { execFileSync } from "node:child_process";
import path from "node:path";
import { Project, type SourceFile } from "ts-morph";
import { describe, expect, test } from "vitest";
import { QualityEngine } from "../application/QualityEngine";
import { listTrackedFiles } from "../infra/TrackedFileEnumeration";
import { TranscriptGuardRule } from "../rules/streaming";
import { AuthorizationRegexBypassRule, UnsafePropertyAccessRule } from "../rules/security";

// PR 129 review regressions, batch 2: streaming substring guard (#34),
// split/matchAll index exemption (#57), destructured declaration crash (#74),
// and tracked-file enumeration from a subdirectory (#58).

function source(code: string, filePath: string): SourceFile {
  return new Project({ useInMemoryFileSystem: true }).createSourceFile(filePath, code);
}

describe("TranscriptGuardRule: guard must be a real 400 response, not a substring (#34)", () => {
  test("a literal 4000 does not count as the 400 guard", () => {
    const sf = source(
      `
      app.post("/analyze", (c) => {
        const transcript = load();
        const limit = 4000;
        return stream(transcript, analyze, limit);
      });
      `,
      "web/app/api/analyze/route.ts",
    );
    const findings = TranscriptGuardRule.check({ filePath: "web/app/api/analyze/route.ts", ast: sf, allFiles: [] });
    expect(findings.length).toBe(1);
  });

  test("an explicit status 400 response still counts as the guard", () => {
    const sf = source(
      `
      app.post("/analyze", (c) => {
        const transcript = load();
        if (!transcript) return c.json({ error: "x" }, { status: 400 });
        return stream(transcript, analyze);
      });
      `,
      "web/app/api/analyze/route.ts",
    );
    const findings = TranscriptGuardRule.check({ filePath: "web/app/api/analyze/route.ts", ast: sf, allFiles: [] });
    expect(findings.length).toBe(0);
  });
});

describe("UnsafePropertyAccessRule: split/matchAll exemption applies to index 0 only (#57)", () => {
  test("split(...)[1] on an unchecked result is still flagged", () => {
    const sf = source(
      `
      export async function fetchPart(line: string) {
        const v = line.split("=")[1].trim();
        return fetch(v);
      }
      `,
      "web/lib/parse-part.ts",
    );
    const findings = UnsafePropertyAccessRule.check(sf);
    expect(findings.length).toBe(1);
  });
});

describe("UnsafePropertyAccessRule: an unguarded split index is flagged only when dereferenced (#57 follow-up)", () => {
  test("Number(split(...)[1]) is not flagged: Number(undefined) is NaN and the caller checks Number.isInteger", () => {
    const sf = source(
      `
      export async function totalOf(header: string | null) {
        const total = Number(header?.split("/")[1]);
        if (!Number.isInteger(total)) throw new Error("bad");
        return fetch(String(total));
      }
      `,
      "web/lib/total.ts",
    );
    expect(UnsafePropertyAccessRule.check(sf).length).toBe(0);
  });
});

describe("AuthorizationRegexBypassRule: a destructured declaration does not crash the scan (#74)", () => {
  test("a binding-pattern declaration in the same file is skipped, not turned into a RegExp", () => {
    const sf = source(
      `
      const { a = "(" } = cfg;
      export function gate(email: string) {
        if (/^founder$/.test(email)) {
          return founderEntitlement;
        }
        return null;
      }
      `,
      "web/lib/gate.ts",
    );
    expect(() => AuthorizationRegexBypassRule.check(sf)).not.toThrow();
  });
});

describe("listTrackedFiles: same list from a subdirectory as from the repo root (#58)", () => {
  test("cwd inside scripts/ returns repo-root-relative paths", () => {
    const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const fromRoot = listTrackedFiles(repo);
    const fromSub = listTrackedFiles(path.join(repo, "scripts"));
    expect(fromSub).toEqual(fromRoot);
  });
});

describe("QualityEngine: no AST cache write without a reader (#24, #69)", () => {
  test("analyzing a file does not write its AST to the cache", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("web/lib/a.ts", "export const a = 1;\n", { overwrite: true });
    const loader = {
      load: async (p: string) => project.getSourceFileOrThrow(p),
      loadFromText: async (p: string, text: string) => project.createSourceFile(p, text, { overwrite: true }),
      getImports: () => [] as string[],
    };
    const fs = { exists: (p: string) => !!project.getSourceFile(p), resolve: (p: string) => p };
    let writes = 0;
    const counting = { getAST: async () => undefined, setAST: async (..._args: unknown[]) => { writes++; } };
    const engine = new QualityEngine([], loader as never, counting as never, fs as never, { mode: "diff" } as never);
    await engine.analyze(["web/lib/a.ts"]);
    expect(writes).toBe(0);
  });
});
