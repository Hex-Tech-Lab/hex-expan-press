import { QA_INTEL_CONFIG } from "./config";

/** Runs `git <args>` and returns stdout, or throws when git exits non-zero. */
export type GitRun = (args: readonly string[]) => string;

/**
 * Diff base for `--mode diff`: the repo's own default branch from origin/HEAD when recorded,
 * otherwise the first candidate ref that exists. Throws when none exists, so a missing base
 * fails loudly instead of diffing against a ref that is not there.
 */
export function resolveDefaultBaseRef(
  git: GitRun,
  candidates: readonly string[] = QA_INTEL_CONFIG.baseRefCandidates,
): string {
  try {
    const ref = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
    if (ref) return ref;
  } catch {
    // origin/HEAD is not recorded; fall through to the candidates.
  }
  for (const candidate of candidates) {
    try {
      git(["rev-parse", "--verify", "--quiet", `refs/remotes/${candidate}`]);
      return candidate;
    } catch {
      // This candidate does not exist; try the next.
    }
  }
  throw new Error(`qa-intel: no diff base found. Tried origin/HEAD, then ${candidates.join(", ")}. Pass --base <ref>.`);
}
