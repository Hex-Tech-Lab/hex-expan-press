import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CONTRACT_AUDITOR_CONFIG } from "../config";
import { defaultRepoRoot, runContractAudit, type Io } from "../cli";

let root: string;
let out: string[];
let err: string[];
const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l) };

/** A repo with one silent critical: a missing-config warning that exits 0. */
function seedCriticalRepo(dir: string) {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const webDir = join(dir, "web");
  mkdirSync(webDir, { recursive: true });
  writeFileSync(
    join(webDir, "setup.ts"),
    'console.warn("config missing, skipping");\nprocess.exit(0);\n',
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "contract-cli-"));
  out = [];
  err = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runContractAudit", () => {
  test("exit 2 when no scan root exists, naming the expected roots", () => {
    expect(runContractAudit([root], root, io)).toBe(2);
    expect(err.join("\n")).toContain(`expected ${CONTRACT_AUDITOR_CONFIG.scanRoots.join("/, ")}/`);
  });

  test("exit 0 on a clean tree, reporting 0 criticals", () => {
    mkdirSync(join(root, "web"), { recursive: true });
    writeFileSync(join(root, "web", "ok.ts"), "export const x = 1;\n");
    expect(runContractAudit([root], root, io)).toBe(0);
    expect(err.join("\n")).toContain("0 new critical finding(s) not in the baseline (0 accepted)");
    expect(JSON.parse(out[0]!).criticalCount).toBe(0);
  });

  test("exit 1 when a critical has no baseline entry", () => {
    seedCriticalRepo(root);
    expect(runContractAudit([root], root, io)).toBe(1);
    expect(err.join("\n")).toContain("1 new critical finding(s)");
  });

  test("--baseline accepts the current criticals and writes the baseline file (exit 0)", () => {
    seedCriticalRepo(root);
    expect(runContractAudit([root, "--baseline"], root, io)).toBe(0);
    expect(err.join("\n")).toContain("baseline written (1 accepted critical finding(s))");
    const written = JSON.parse(readFileSync(join(root, CONTRACT_AUDITOR_CONFIG.baselineFile), "utf-8"));
    expect(written).toHaveLength(1);
    expect(written[0].reason).toBe("");
  });

  test("--baseline without a written reason makes the next gate run refuse", () => {
    seedCriticalRepo(root);
    runContractAudit([root, "--baseline"], root, io);
    expect(() => runContractAudit([root], root, io)).toThrow("with no reason");
  });

  test("after --baseline and a written reason the gate passes, and the accepted count is reported", () => {
    seedCriticalRepo(root);
    runContractAudit([root, "--baseline"], root, io);
    const path = join(root, CONTRACT_AUDITOR_CONFIG.baselineFile);
    const entries = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify(entries.map((e: { reason: string }) => ({ ...e, reason: "reviewed in test" })), null, 2));
    err = [];
    expect(runContractAudit([root], root, io)).toBe(0);
    expect(err.join("\n")).toContain("0 new critical finding(s) not in the baseline (1 accepted)");
  });

  test("--baseline keeps a reason a human already wrote", () => {
    seedCriticalRepo(root);
    runContractAudit([root, "--baseline"], root, io);
    const path = join(root, CONTRACT_AUDITOR_CONFIG.baselineFile);
    const entries = JSON.parse(readFileSync(path, "utf-8"));
    entries[0].reason = "documented";
    writeFileSync(path, JSON.stringify(entries));
    runContractAudit([root, "--baseline"], root, io);
    expect(JSON.parse(readFileSync(path, "utf-8"))[0].reason).toBe("documented");
  });

  test("a corrupt baseline throws, so the caller exits 2 (fail closed)", () => {
    seedCriticalRepo(root);
    writeFileSync(join(root, CONTRACT_AUDITOR_CONFIG.baselineFile), "{oops");
    expect(() => runContractAudit([root], root, io)).toThrow();
  });

  test("the first positional argument is the root; flags are never taken for it", () => {
    seedCriticalRepo(root);
    const other = mkdtempSync(join(tmpdir(), "contract-cli-other-"));
    try {
      // The fallback root is empty; the positional root is the seeded one, so the result is 1, not 2.
      expect(runContractAudit(["--baseline-ignored", root], other, io)).toBe(1);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("with no positional argument, the fallback root is used", () => {
    seedCriticalRepo(root);
    expect(runContractAudit([], root, io)).toBe(1);
  });
});

describe("defaultRepoRoot", () => {
  test("resolves to the repo root (where package.json lives)", () => {
    expect(readFileSync(join(defaultRepoRoot(), "package.json"), "utf-8")).toContain('"name"');
  });
});
