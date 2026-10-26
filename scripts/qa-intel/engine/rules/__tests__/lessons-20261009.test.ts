import { afterAll, beforeAll, describe, test, expect } from "vitest";
import { Project } from "ts-morph";
import * as legacyRules from "../index";
import {
  StreamReaderWithoutFinallyRule,
  UnregisteredSettingsKeyRule,
  _resetSettingsManifestCacheForTest,
} from "../lessons-20261009";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Rule } from "../../domain/Rule";

// Settings-key checks read the real supabase/migrations manifest, found by walking
// up from the cwd, so these run from the repo root or any subdirectory.
function run(rule: Rule, code: string, filePath = "web/lib/example.ts") {
  const project = new Project({ useInMemoryFileSystem: true });
  const ast = project.createSourceFile(filePath, code);
  return rule.check({ filePath, ast });
}

describe("StreamReaderWithoutFinallyRule", () => {
  test("flags a getReader() with no finally that releases it", () => {
    const findings = run(StreamReaderWithoutFinallyRule, `
      export async function drain(res: Response) {
        const reader = res.body!.getReader();
        const first = await reader.read();
        return first;
      }`);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("Stream reader not released in a finally block");
  });

  test("a finally that releases a DIFFERENT reader does not count", () => {
    const findings = run(StreamReaderWithoutFinallyRule, `
      export async function drain(a: Response, b: Response) {
        const ra = a.body!.getReader();
        const rb = b.body!.getReader();
        try { await rb.read(); await ra.read(); } finally { rb.releaseLock(); }
      }`);
    expect(findings).toHaveLength(1);
  });

  test("optional-chained release of the same reader counts", () => {
    const findings = run(StreamReaderWithoutFinallyRule, `
      export async function drain(res: Response) {
        const reader = res.body?.getReader();
        try { await reader?.read(); } finally { reader?.releaseLock(); }
      }`);
    expect(findings).toHaveLength(0);
  });

  test("passes when a finally releases the lock", () => {
    const findings = run(StreamReaderWithoutFinallyRule, `
      export async function drain(res: Response) {
        const reader = res.body!.getReader();
        try {
          return await reader.read();
        } finally {
          reader.releaseLock();
        }
      }`);
    expect(findings).toHaveLength(0);
  });

  test("passes when a finally cancels the reader", () => {
    const findings = run(StreamReaderWithoutFinallyRule, `
      export async function drain(res: Response) {
        const reader = res.body!.getReader();
        try {
          return await reader.read();
        } finally {
          await reader.cancel();
        }
      }`);
    expect(findings).toHaveLength(0);
  });

  test("ignores test files", () => {
    const findings = run(StreamReaderWithoutFinallyRule, `const r = body.getReader();`, "web/lib/__tests__/x.test.ts");
    expect(findings).toHaveLength(0);
  });
});

describe("UnregisteredSettingsKeyRule", () => {
  // The rule reads its manifest from supabase/migrations at run time. hex-expan keeps its registry in
  // TypeScript, so the cases get their own manifest: a temp tree with one registered `analysis.*` key.
  // The rule is then active in every checkout, and the cases never skip.
  const original = process.cwd();
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "qe-settings-manifest-"));
    mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
    writeFileSync(
      path.join(root, "supabase", "migrations", "0001_settings.sql"),
      "insert into setting_definitions values ('analysis.layer2.priorPayloadMaxBytes', 'system', 1);\n"
    );
    process.chdir(root);
    _resetSettingsManifestCacheForTest();
  });
  afterAll(() => {
    process.chdir(original);
    _resetSettingsManifestCacheForTest();
    rmSync(root, { recursive: true, force: true });
  });

  test("flags a *_KEY constant that names an unregistered key under a registry prefix", () => {
    const findings = run(UnregisteredSettingsKeyRule, `export const CAP_KEY = 'analysis.layer2.priorPayloadMaxBytess';`);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("Settings key not registered in setting_definitions");
  });

  test("flags an unregistered `as const` key constant (the shape the epistemic retry key uses)", () => {
    const findings = run(UnregisteredSettingsKeyRule, `export const RETRY_KEY = 'analysis.pipeline.retry.epistemc' as const;`);
    expect(findings).toHaveLength(1);
  });

  test("passes a *_KEY constant that is registered in a migration", () => {
    const findings = run(UnregisteredSettingsKeyRule, `export const CAP_KEY = 'analysis.layer2.priorPayloadMaxBytes';`);
    expect(findings).toHaveLength(0);
  });

  test("ignores dotted strings whose prefix is not a registry prefix", () => {
    const findings = run(UnregisteredSettingsKeyRule, `export const LOG_KEY = 'somewhere.else.entirely';`);
    expect(findings).toHaveLength(0);
  });

  test("flags an unregistered literal passed to a registry-style call", () => {
    const findings = run(UnregisteredSettingsKeyRule, `resolveSettings(['analysis.pipeline.epistmic']);`);
    expect(findings).toHaveLength(1);
  });

  test("ignores test files", () => {
    const findings = run(UnregisteredSettingsKeyRule, `export const RETRY_KEY = 'analysis.pipeline.retry.epistemc';`, "web/lib/__tests__/x.test.ts");
    expect(findings).toHaveLength(0);
  });
});

describe("lessons-20261009 rules — production registration", () => {
  test("both rules are exported through the production registration set", () => {
    const registered = Object.values(legacyRules);
    expect(registered).toContain(StreamReaderWithoutFinallyRule);
    expect(registered).toContain(UnregisteredSettingsKeyRule);
  });

  test("both rules use the file scope the engine dispatches on", () => {
    for (const rule of [StreamReaderWithoutFinallyRule, UnregisteredSettingsKeyRule]) {
      expect((rule as { scope?: string }).scope).toBe("file");
    }
  });

  describe("migrations directory lookup", () => {
    const original = process.cwd();
    const UNREGISTERED = `export const CAP_KEY = 'analysis.layer2.priorPayloadMaxBytess';`;

    function withCwd(dir: string, fn: () => void) {
      try {
        process.chdir(dir);
        _resetSettingsManifestCacheForTest();
        fn();
      } finally {
        process.chdir(original);
        _resetSettingsManifestCacheForTest();
      }
    }

    test("walks up from a nested directory to find supabase/migrations", () => {
      const root = mkdtempSync(path.join(tmpdir(), "qe-walkup-"));
      mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
      // One registered key, so the manifest is non-empty and the rule is active.
      writeFileSync(
        path.join(root, "supabase", "migrations", "0001_settings.sql"),
        "insert into setting_definitions values ('analysis.other.key', 'system', 1);\n"
      );
      const nested = path.join(root, "web", "lib");
      mkdirSync(nested, { recursive: true });
      // Manifest found by walking up, so an unregistered key is flagged even from web/lib.
      withCwd(nested, () => {
        expect(run(UnregisteredSettingsKeyRule, UNREGISTERED)).toHaveLength(1);
      });
    });

    test("disables itself when no migrations directory exists anywhere above", () => {
      const bare = mkdtempSync(path.join(tmpdir(), "qe-nomig-"));
      withCwd(bare, () => {
        expect(run(UnregisteredSettingsKeyRule, UNREGISTERED)).toHaveLength(0);
      });
    });
  });
});
