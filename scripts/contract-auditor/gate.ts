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
  const valid =
    Array.isArray(parsed) &&
    parsed.every((e) => typeof e === "object" && e !== null && typeof (e as BaselineEntry).fingerprint === "string");
  if (!valid) throw new Error(`baseline at ${path} is not a list of accepted fingerprints. Fix or delete it.`);
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

export function newCriticals(findings: Finding[], accepted: Set<string>): Finding[] {
  return findings.filter((f) => f.severity === "critical" && !accepted.has(f.fingerprint!));
}

export function writeBaseline(path: string, entries: BaselineEntry[]): void {
  writeFileSync(path, JSON.stringify(entries, null, 2) + "\n");
}
