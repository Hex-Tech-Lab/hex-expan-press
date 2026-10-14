// Fixture tests for scripts/strict-merge.sh (the merge gate). `gh` is replaced by a stub on PATH
// that serves JSON fixtures and logs merge calls; no network, no real PR.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(__dirname, "../../../..");
const SCRIPT = path.join(REPO, "scripts/strict-merge.sh");
const STUB_DIR = path.join(REPO, "web/tests/fixtures/strict-merge/bin");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "strict-merge-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const greenPr = (checks: unknown[] = [{ __typename: "CheckRun", name: "ci", conclusion: "SUCCESS" }]) => ({
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  headRefOid: "a".repeat(40),
  title: "fixture PR",
  statusCheckRollup: checks,
});

const threads = (nodes: Array<{ isResolved: boolean }>) => ({
  data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: nodes.map((n) => ({ ...n, path: "a.ts", line: 1 })) } } } },
});

function run(args: string[], opts: { pr: unknown; threads: unknown; late?: unknown }) {
  const prFile = path.join(dir, "pr.json");
  const thFile = path.join(dir, "threads.json");
  const logFile = path.join(dir, "merge.log");
  writeFileSync(prFile, JSON.stringify(opts.pr));
  writeFileSync(thFile, JSON.stringify(opts.threads));
  writeFileSync(logFile, "");
  const env: Record<string, string | undefined> = {
    PATH: `${STUB_DIR}:${process.env.PATH}`,
    HOME: process.env.HOME,
    FIXTURE_PR_JSON: prFile,
    FIXTURE_THREADS_JSON: thFile,
    FIXTURE_MERGE_LOG: logFile,
  };
  if (opts.late) {
    const lateFile = path.join(dir, "late.json");
    writeFileSync(lateFile, JSON.stringify(opts.late));
    env.FIXTURE_LATE_THREADS_JSON = lateFile;
  }
  const res = spawnSync("bash", [SCRIPT, "7", ...args], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  const merged = existsSync(logFile) ? readFileSync(logFile, "utf8").trim() : "";
  return { status: res.status, out: `${res.stdout}${res.stderr}`, merged };
}

describe("strict-merge.sh gate", () => {
  it("all checks green and no open threads → gate passes (exit 0)", () => {
    const r = run([], { pr: greenPr(), threads: threads([{ isResolved: true }]) });
    expect(r.status).toBe(0);
    expect(r.merged).toBe("");
  });

  it("an unresolved review thread → gate refuses (exit 1)", () => {
    const r = run([], { pr: greenPr(), threads: threads([{ isResolved: false }]) });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/unresolved|open/i);
  });

  it("a failing check without --bypass → gate refuses (exit 1)", () => {
    const r = run([], {
      pr: greenPr([{ __typename: "CheckRun", name: "lint", conclusion: "FAILURE" }]),
      threads: threads([]),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("check not passing: lint = FAILURE");
  });

  it("a failing check named in --bypass → passes and prints the bypass (never silent)", () => {
    const r = run(["--bypass", "lint"], {
      pr: greenPr([{ __typename: "CheckRun", name: "lint", conclusion: "FAILURE" }]),
      threads: threads([]),
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain("lint");
  });

  it("a thread opened after the gate check blocks the merge even with --merge (exit 1, no merge call)", () => {
    const r = run(["--merge"], {
      pr: greenPr(),
      threads: threads([]),
      late: threads([{ isResolved: false }]),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("opened after the gate check");
    expect(r.merged).toBe("");
  });
});
