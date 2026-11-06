/** The part of a finding that `--compare` keys on. */
export type ComparableFinding = { file: string; title: string };

/**
 * Findings in the scan that the baseline does not account for.
 *
 * The baseline is a multiset: each baseline entry covers one copy of its (file, title).
 * A scan copy beyond the baseline count is new, so a second copy of an accepted finding fails the gate.
 * Fewer copies than the baseline is not a failure. The key is JSON-encoded so a colon inside
 * either field cannot make two different (file, title) pairs collide.
 */
export function newFindingsAgainstBaseline<T extends ComparableFinding>(findings: readonly T[], baseline: readonly ComparableFinding[]): T[] {
  const remaining = new Map<string, number>();
  for (const entry of baseline) {
    const key = findingKey(entry);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const fresh: T[] = [];
  for (const finding of findings) {
    const key = findingKey(finding);
    const covered = remaining.get(key) ?? 0;
    if (covered > 0) {
      remaining.set(key, covered - 1);
    } else {
      fresh.push(finding);
    }
  }
  return fresh;
}

function findingKey(finding: ComparableFinding): string {
  return JSON.stringify([finding.file, finding.title]);
}
