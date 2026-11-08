/**
 * TypeScript globs the full-mode scan walks. The scanner's own sources under scripts/ are not listed,
 * and SELF_SCAN_EXCLUDE in the runner keeps them out of the diff-mode scan.
 */
export const FULL_MODE_CODE_GLOBS: readonly string[] = ["{web,worker}/**/*.{ts,tsx}", "payments/**/*.ts", "src/**/*.ts"];

const normalizePath = (p: string): string => p.replace(/\\/g, "/");

/**
 * Diff filter for name-only scans. R (renamed) is included: a file that was moved and edited keeps its defects,
 * and git reports it under status R, so ACM alone would drop it from the scan.
 */
export const DIFF_NAME_FILTER = "ACMR";

/** Argument list for `git diff --name-only` over the given revision range. */
export function diffNameOnlyArgs(...revisions: readonly string[]): string[] {
  return ["diff", "--name-only", `--diff-filter=${DIFF_NAME_FILTER}`, ...revisions];
}

/** Keeps only the paths git tracks. A full-mode scan must not pick up untracked local files. */
export function restrictToTracked(files: readonly string[], tracked: readonly string[]): string[] {
  const trackedSet = new Set(tracked.map(normalizePath));
  return files.map(normalizePath).filter((f) => trackedSet.has(f));
}

/** Why --baseline is refused for this mode, or null when it is allowed. A partial scan must never overwrite the full baseline. */
export function baselineRefusal(mode: string): string | null {
  if (mode === "full" || mode === "watch") return null;
  return `❌ qa-intel: --baseline is only allowed in full or watch mode. Mode "${mode}" scans a subset, and writing it would replace the full-repo .qa-intel/baseline.json.`;
}
