import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { importTimeDotenvLeaks } from "../lint/import-time-dotenv.ts";

// Pre-fix shape of scripts/sync-supabase-to-r2.ts (commit before b543f30): dotenv loads at import time.
const PRE_FIX_SYNC = `import dotenv from "dotenv";
dotenv.config();
export const syncValue = 1;
`;

// Post-fix shape (b543f30): dotenv loads only in the direct-CLI branch, never on import.
const POST_FIX_SYNC = `import dotenv from "dotenv";
export const syncValue = 1;
if (process.argv[1] && process.argv[1].endsWith("sync-supabase-to-r2.ts")) {
  dotenv.config();
}
`;

const TEST_IMPORTING_SYNC = `import { describe, it, expect } from "vitest";
import { syncValue } from "../sync.ts";
describe("sync", () => it("loads", () => expect(syncValue).toBe(1)));
`;

describe("import-time dotenv rule", () => {
  it("repository: no test imports a module that loads .env at import time", () => {
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    project.addSourceFilesAtPaths([
      "scripts/**/*.ts",
      "payments/**/*.ts",
      "src/**/*.ts",
      "web/app/**/*.ts",
      "web/src/**/*.ts",
      "!**/node_modules/**",
      "!**/*.d.ts",
    ]);
    expect(importTimeDotenvLeaks(project)).toEqual([]);
  }, 180_000);

  it("catches the pre-fix leak: a test imports a module that calls dotenv.config() at top level", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("/repo/scripts/sync.ts", PRE_FIX_SYNC);
    project.createSourceFile("/repo/scripts/__tests__/sync.test.ts", TEST_IMPORTING_SYNC);
    const leaks = importTimeDotenvLeaks(project);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toContain("/repo/scripts/sync.ts");
  });

  it("passes the post-fix shape: the loader is conditional, so import does not load .env", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("/repo/scripts/sync.ts", POST_FIX_SYNC);
    project.createSourceFile("/repo/scripts/__tests__/sync.test.ts", TEST_IMPORTING_SYNC);
    expect(importTimeDotenvLeaks(project)).toEqual([]);
  });

  it("catches a test file that loads .env unconditionally", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("/repo/scripts/__tests__/env.test.ts", `import dotenv from "dotenv";\ndotenv.config();\n`);
    expect(importTimeDotenvLeaks(project)).toHaveLength(1);
  });

  it("catches a side-effect import of dotenv/config in an imported module", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("/repo/scripts/sync.ts", `import "dotenv/config";\nexport const syncValue = 1;\n`);
    project.createSourceFile("/repo/scripts/__tests__/sync.test.ts", TEST_IMPORTING_SYNC);
    expect(importTimeDotenvLeaks(project)).toHaveLength(1);
  });
});
