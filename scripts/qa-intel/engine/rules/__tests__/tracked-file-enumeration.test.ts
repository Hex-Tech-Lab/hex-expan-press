import { describe, test, expect } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { listTrackedFiles, selectScannableTextFiles, isSqlMigration, TEXT_FILE_EXT } from "../../infra/TrackedFileEnumeration";

// R12 round 2 (2026-09-25): full-mode text-file enumeration policy.
// These tests run against the REAL repo checkout (they invoke the real
// `git ls-files -z`), asserting the policy surface: tracked dot-directories are listed, untracked files are
// excluded. Every file name below is read from the index at run time, never typed in.

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const dotDirFiles = (files: string[]) => files.filter((f) => /^\.[^/]+\//.test(f));

describe("TrackedFileEnumeration (R12 round 2)", () => {
  test("lists real tracked files, POSIX-normalized, incl. hidden dirs", () => {
    const files = listTrackedFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.includes("\\"))).toBe(false);
    expect(dotDirFiles(files).length).toBeGreaterThan(0);
  });

  test("hidden-dir tracked text files pass the text-extension policy", () => {
    const hidden = dotDirFiles(listTrackedFiles(REPO_ROOT)).filter((f) => TEXT_FILE_EXT.test(f));
    expect(hidden.length).toBeGreaterThan(0);
    expect(selectScannableTextFiles(hidden)).toEqual(hidden);
  });

  test("nested hidden-dir text files (every tracked .github/workflows/* file) pass the policy", () => {
    const workflows = listTrackedFiles(REPO_ROOT).filter((f) => f.startsWith(".github/workflows/") && TEXT_FILE_EXT.test(f));
    expect(workflows.length).toBeGreaterThan(0);
    const selected = selectScannableTextFiles(listTrackedFiles(REPO_ROOT));
    for (const workflow of workflows) expect(selected).toContain(workflow);
  });

  test("never lists untracked files (git ls-files lists the index only)", () => {
    const probeDir = join(REPO_ROOT, ".scratch");
    const probeName = "r12-untracked-probe.md";
    const existedBefore = existsSync(probeDir);
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(join(probeDir, probeName), "deliberately untracked probe\n");
    try {
      const files = listTrackedFiles(REPO_ROOT);
      expect(files).not.toContain(`.scratch/${probeName}`);
      expect(selectScannableTextFiles(files)).not.toContain(`.scratch/${probeName}`);
    } finally {
      // Clean up the probe so the working tree is left as it was.
      rmSync(join(probeDir, probeName), { force: true });
      if (!existedBefore) rmSync(probeDir, { recursive: true, force: true });
    }
  });

  test("policy excludes pnpm-lock.yaml (generated lockfile denylist)", () => {
    const files = listTrackedFiles(REPO_ROOT);
    expect(files).toContain("pnpm-lock.yaml");
    expect(selectScannableTextFiles(files)).not.toContain("pnpm-lock.yaml");
  });

  test("supabase/migrations/*.sql are NOT selected into the text-only pass (code routing preserved)", () => {
    const tracked = listTrackedFiles(REPO_ROOT).filter(isSqlMigration);
    expect(tracked.length).toBeGreaterThan(0);
    const selected = selectScannableTextFiles(listTrackedFiles(REPO_ROOT));
    for (const migration of tracked) {
      expect(selected).not.toContain(migration);
    }
  });

  test("non-text tracked files (e.g. .ts) are not selected into the text pass", () => {
    const selected = selectScannableTextFiles(listTrackedFiles(REPO_ROOT));
    expect(selected.every((f) => /\.(md|mdx|sql|json|ya?ml|sh|txt)$/.test(f))).toBe(true);
  });
});