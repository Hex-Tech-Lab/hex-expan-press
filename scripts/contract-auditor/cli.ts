import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { CONTRACT_AUDITOR_CONFIG } from "./config";
import { baselinePathFor, buildBaseline, newCriticals, readBaseline, writeBaseline } from "./gate";
import { scan, type Finding } from "./rules";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** The repo root is two directories above this file: scripts/contract-auditor/cli.ts. */
export function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Runs the audit and returns the exit code: 0 clean or baseline written, 1 new criticals,
 * 2 no scan root. Errors thrown by the baseline reader propagate to the entry, which exits 2.
 * Only the first positional argument is read as the repo root, so flags are never taken for it.
 */
export function runContractAudit(argv: readonly string[], fallbackRoot: string, io: Io): number {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const repoRoot = positional[0] ? resolve(positional[0]) : fallbackRoot;
  const roots = CONTRACT_AUDITOR_CONFIG.scanRoots.map((r) => join(repoRoot, r));
  // walk() treats an unreadable directory as empty, so a wrong root would scan nothing and report clean. Fail loudly.
  if (!roots.some((r) => existsSync(r))) {
    io.err(
      `Contract Auditor: no scan root under ${repoRoot} (expected ${CONTRACT_AUDITOR_CONFIG.scanRoots.join("/, ")}/). Pass the repo root as the first argument.`,
    );
    return 2;
  }

  const findings: Finding[] = scan(repoRoot);
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  io.out(JSON.stringify({ runAt: new Date().toISOString(), criticalCount, warningCount, findings }, null, 2));
  io.err(`\nContract Auditor: ${criticalCount} critical, ${warningCount} warning finding(s).`);

  const baselinePath = baselinePathFor(repoRoot);
  if (argv.includes("--baseline")) {
    const entries = buildBaseline(findings, readBaseline(baselinePath));
    writeBaseline(baselinePath, entries);
    io.err(`Contract Auditor: baseline written (${entries.length} accepted critical finding(s)) to ${baselinePath}.`);
    return 0;
  }

  const accepted = new Set(readBaseline(baselinePath).map((e) => e.fingerprint));
  const fresh = newCriticals(findings, accepted);
  io.err(
    `Contract Auditor: ${fresh.length} new critical finding(s) not in the baseline (${criticalCount - fresh.length} accepted).`,
  );
  return fresh.length > 0 ? 1 : 0;
}
