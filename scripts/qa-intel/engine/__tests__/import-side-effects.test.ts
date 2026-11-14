import { describe, expect, test } from "vitest";
import { Project, type SourceFile } from "ts-morph";
import { ImportSideEffectsRule } from "../rules/import-side-effects";

// One in-memory project shared by the file, as in wave9-new-rules.test.ts, to keep each case cheap.
const sharedProject = new Project({ useInMemoryFileSystem: true });
let sourceCount = 0;
function createTestSource(code: string): SourceFile {
  return sharedProject.createSourceFile(`side-effects-${sourceCount++}.ts`, code, { overwrite: true });
}

describe("ImportSideEffectsRule", () => {
  test("(a) flags a top-level dotenv.config() call as critical", () => {
    const source = createTestSource(`
      import dotenv from "dotenv";
      dotenv.config();
      export const syncValue = 1;
    `);
    const findings = ImportSideEffectsRule.check(source);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].title).toContain("top-level dotenv.config()");
    expect(findings[0].why).toContain("Line 3");
    expect(findings[0].fix).toContain("entry point");
  });

  test("(b) does not flag dotenv.config() inside a function body", () => {
    const source = createTestSource(`
      import dotenv from "dotenv";
      export function loadEnv() {
        dotenv.config();
      }
    `);
    expect(ImportSideEffectsRule.check(source)).toHaveLength(0);
  });

  test("(c) does not flag dotenv.config() inside a direct-run guard", () => {
    const cjsGuard = createTestSource(`
      import dotenv from "dotenv";
      export const syncValue = 1;
      if (require.main === module) {
        dotenv.config();
      }
    `);
    expect(ImportSideEffectsRule.check(cjsGuard)).toHaveLength(0);

    const esmGuard = createTestSource(`
      import dotenv from "dotenv";
      import { pathToFileURL } from "node:url";
      export const syncValue = 1;
      if (import.meta.url === pathToFileURL(process.argv[1]).href) {
        dotenv.config();
      }
    `);
    expect(ImportSideEffectsRule.check(esmGuard)).toHaveLength(0);
  });

  test("(d) flags a side-effect import of dotenv/config as critical", () => {
    const source = createTestSource(`
      import "dotenv/config";
      export const syncValue = 1;
    `);
    const findings = ImportSideEffectsRule.check(source);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].title).toContain("dotenv/config");
  });

  test("does not flag a dotenv import that never calls config at top level", () => {
    const source = createTestSource(`
      import dotenv from "dotenv";
      export const parse = (src: string) => dotenv.parse(src);
    `);
    expect(ImportSideEffectsRule.check(source)).toHaveLength(0);
  });
});
