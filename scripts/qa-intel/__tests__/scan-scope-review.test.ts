import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { baselineRefusal, diffNameOnlyArgs, restrictToTracked } from "../scan-scope";

// Regression tests for PR 129 review threads on scripts/qa-intel.ts scan scope.

describe("full mode scans only tracked files (cubic P1 #03, CodeRabbit #75)", () => {
  test("an untracked file that matches a glob is dropped", () => {
    const globHits = ["web/app/tracked.ts", "web/app/scratch.ts"];
    const tracked = ["web/app/tracked.ts"];
    expect(restrictToTracked(globHits, tracked)).toEqual(["web/app/tracked.ts"]);
  });

  test("backslash paths from Windows globs compare equal to tracked paths", () => {
    expect(restrictToTracked(["web\\app\\a.ts"], ["web/app/a.ts"])).toEqual(["web/app/a.ts"]);
  });
});

describe("diff mode includes renamed files (CodeRabbit #76)", () => {
  test("the diff filter includes R (renamed) and keeps A, C, M", () => {
    const args = diffNameOnlyArgs("origin/main");
    expect(args).toEqual(["diff", "--name-only", "--diff-filter=ACMR", "origin/main"]);
  });

  let repo: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "scope-rename-"));
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    // A realistically sized file: git only pairs a rename reliably when the content is large enough to hash.
    const body = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i} * 2; // stable line ${i}\n`);
    writeFileSync(join(repo, "a.ts"), body.join(""));
    git("add", "-A");
    git("commit", "-qm", "one");
    git("mv", "a.ts", "b.ts");
    writeFileSync(join(repo, "b.ts"), body.map((l, i) => (i === 7 ? l.replace("= 7 *", "= 70 *") : l)).join(""));
    git("add", "-A");
    git("commit", "-qm", "two");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("a file moved and edited in the same branch is reported under its new path", () => {
    const out = execFileSync("git", diffNameOnlyArgs("HEAD~1", "HEAD"), { cwd: repo, encoding: "utf8" });
    expect(out.trim().split("\n")).toEqual(["b.ts"]);
  });

  test("the previous ACM filter drops the same file, which is the defect this test pins", () => {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACM", "HEAD~1", "HEAD"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(out.trim()).toBe("");
  });
});

describe("--baseline is refused outside full mode (CodeRabbit #66)", () => {
  test("diff, working-tree and HEAD modes are refused with a clear message", () => {
    for (const mode of ["diff", "working-tree", "HEAD"]) {
      const why = baselineRefusal(mode);
      expect(why).toContain("only allowed in full or watch mode");
      expect(why).toContain(`"${mode}"`);
    }
  });

  test("full and watch modes are allowed", () => {
    expect(baselineRefusal("full")).toBeNull();
    expect(baselineRefusal("watch")).toBeNull();
  });
});
