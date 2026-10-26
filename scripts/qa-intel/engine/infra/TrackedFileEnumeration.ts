import { execFileSync } from "child_process";

/**
 * R12 (2026-09-25, PR #334 round 2): full-mode text-file enumeration policy.
 *
 * The first cut used glob patterns (TEXT_GLOBS), which silently missed
 * tracked text files in HIDDEN directories (e.g. `.memory/AGENT_LEDGER.md`,
 * `.github/workflows/*.yml`) and could pick up UNTRACKED working-tree files.
 * Full mode now enumerates tracked files via `git ls-files -z` and applies a
 * deliberate text-extension policy:
 *
 *   - tracked only (never untracked files — `git ls-files` lists the index,
 *     so an uncreated/untracked probe file can never enter the scan);
 *   - hidden directories included (ls-files has no hidden-dir filtering);
 *   - extension policy: TEXT_FILE_EXT (.md/.mdx/.sql/.json/.yml/.yaml/.sh/.txt);
 *   - supabase/migrations/*.sql are routed as CODE files (language-gated
 *     full rule set + ConflictMarkerRule), NOT into the text-only pass;
 *   - generated/denylisted files excluded: pnpm-lock.yaml (generated lockfile,
 *     ~huge, zero conflict-marker value).
 */

export const TEXT_FILE_EXT = /\.(md|mdx|sql|json|ya?ml|sh|txt)$/;

export const isSqlMigration = (filePath: string): boolean =>
  filePath.startsWith("supabase/migrations/") && filePath.endsWith(".sql");

const TEXT_DENYLIST = [/^pnpm-lock\.yaml$/];

/** All files tracked by git in the current checkout, POSIX-normalized. */
export function listTrackedFiles(cwd: string = process.cwd()): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\0")
    .filter(Boolean)
    .map((filePath) => filePath.replace(/\\/g, "/"));
}

/**
 * Text-extension policy over a tracked-file list: files eligible for the
 * ConflictMarkerRule-only text pass. SQL migrations are deliberately
 * excluded here (they are code files for the language-gated full set).
 */
export function selectScannableTextFiles(files: string[]): string[] {
  return files.filter(
    (filePath) =>
      TEXT_FILE_EXT.test(filePath) &&
      !isSqlMigration(filePath) &&
      !TEXT_DENYLIST.some((re) => re.test(filePath)),
  );
}