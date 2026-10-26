import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { CONTRACT_AUDITOR_CONFIG } from "./config";
import type { Finding } from "./rules";

export interface BaselineEntry {
  fingerprint: string;
  rule: string;
  file: string;
  snippet: string;
  reason: string;
}

export function baselinePathFor(repoRoot: string): string {
  return join(repoRoot, CONTRACT_AUDITOR_CONFIG.baselineFile);
}

/** Reads the baseline. Missing file: empty list. Unreadable or malformed file: throws (fail closed). */
export function readBaseline(path: string): BaselineEntry[] {
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  const text = (v: unknown) => typeof v === "string" && v.trim() !== "";
  const valid =
    Array.isArray(parsed) &&
    parsed.every((e) => {
      if (typeof e !== "object" || e === null) return false;
      const entry = e as Record<string, unknown>;
      return text(entry.fingerprint) && text(entry.rule) && text(entry.file) && text(entry.snippet);
    });
  if (!valid) throw new Error(`baseline at ${path} is not a list of complete accepted entries. Fix or delete it.`);
  // An accept without a written reason is refused. --baseline writes an empty reason, so it must be filled in before commit.
  const unreasoned = (parsed as BaselineEntry[]).filter((e) => !text(e.reason));
  if (unreasoned.length > 0) {
    throw new Error(`baseline at ${path} has ${unreasoned.length} accepted entr${unreasoned.length === 1 ? "y" : "ies"} with no reason. Write the reason in the file.`);
  }
  return parsed as BaselineEntry[];
}

/**
 * Accept every current critical. A reason already written for an accepted fingerprint is kept,
 * so regenerating the baseline never erases the human-written justification.
 */
export function buildBaseline(findings: Finding[], previous: BaselineEntry[]): BaselineEntry[] {
  const reasons = new Map(previous.map((e) => [e.fingerprint, e.reason ?? ""]));
  return findings
    .filter((f) => f.severity === "critical")
    .map((f) => ({
      fingerprint: f.fingerprint!,
      rule: f.rule,
      file: f.file,
      snippet: f.snippet,
      reason: reasons.get(f.fingerprint!) ?? "",
    }));
}

/**
 * Criticals not covered by the baseline. Each accepted entry covers exactly one finding with its fingerprint, so a
 * second copy of an accepted snippet in the same file is new. A plain set would let it through.
 */
export function newCriticals(findings: Finding[], acceptedFingerprints: string[]): Finding[] {
  const budget = new Map<string, number>();
  for (const fp of acceptedFingerprints) budget.set(fp, (budget.get(fp) ?? 0) + 1);
  return findings.filter((f) => {
    if (f.severity !== "critical") return false;
    const left = budget.get(f.fingerprint!) ?? 0;
    if (left === 0) return true;
    budget.set(f.fingerprint!, left - 1);
    return false;
  });
}

export function writeBaseline(path: string, entries: BaselineEntry[]): void {
  writeFileSync(path, JSON.stringify(entries, null, 2) + "\n");
}
