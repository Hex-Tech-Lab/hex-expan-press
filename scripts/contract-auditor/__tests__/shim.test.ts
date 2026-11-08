import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// The entry shim (scripts/contract-auditor.ts) runs in a child process, which v8 coverage cannot see.
// Its behaviour, meaning the exit code and the stderr line, is asserted here by spawning it under tsx.
const REPO = join(import.meta.dirname, "..", "..", "..");
const TSX = join(REPO, "node_modules", ".bin", "tsx");
const SHIM = join(REPO, "scripts", "contract-auditor.ts");

function runShim(repoRoot: string) {
  return spawnSync(TSX, [SHIM, repoRoot], { encoding: "utf8", cwd: REPO });
}

describe("contract-auditor entry shim (spawned)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "contract-shim-"));
    mkdirSync(join(tmp, "clean", "scripts"), { recursive: true });
    writeFileSync(join(tmp, "clean", "scripts", "ok.ts"), "export const x = 1;\n");
    mkdirSync(join(tmp, "bad", "scripts"), { recursive: true });
    writeFileSync(join(tmp, "bad", "scripts", "ok.ts"), "export const x = 1;\n");
    // A malformed baseline makes readBaseline throw, so the shim's catch is the thing under test.
    writeFileSync(join(tmp, "bad", "scripts", "contract-auditor.baseline.json"), "{not json");
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("the gate exits 0 on a repo with no new criticals", () => {
    const r = runShim(join(tmp, "clean"));
    expect(r.status).toBe(0);
  }, 30_000);

  test("a thrown error is reported on stderr and exits 2 (fail closed, not 0)", () => {
    const r = runShim(join(tmp, "bad"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Contract Auditor:");
  }, 30_000);
});
