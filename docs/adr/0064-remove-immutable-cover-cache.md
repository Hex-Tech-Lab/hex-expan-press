# 0064 — Remove the Immutable Cover Cache Rule

**Status:** Accepted (2026-10-28, founder: "remove them and keep a record in the ADR")
**Date:** 2026-10-28
**Supersedes:** the "Task 3" `/covers/*` rule added in commit `3a62bff` (2026-10-19, AGY agent, "configure immutable cover caching"), in `web/next.config.ts` and `web/vercel.json`.
**Superseded-by:** —

## Context

Commit `3a62bff` set `Cache-Control: public, max-age=31536000, immutable` on `/covers/*` in two places, `web/next.config.ts` and `web/vercel.json`. It was recorded only as "Task 3" in the agent ledger (line 686). No ADR and no memory entry explained it.

Checked on 2026-10-28:

- No commit in the repository has ever added a file under a `covers/` path, and no code writes one.
- The Supabase storage objects table has no object whose name contains "cover".
- No `covers/` directory exists under `web/public`.
- Cover PNGs exist only in `typst_prototype/` and gitignored `data/` scratch folders. None is served by the web app.

An `immutable` one-year cache is safe only when a changed file gets a new URL, for example a content hash in the filename. The rule used fixed paths. A re-published cover would therefore stay stale in browsers and CDN caches for a year.

## Decision

1. **Remove** the `/covers/*` immutable rule from `web/next.config.ts` and `web/vercel.json`.
2. **Keep** the `/assets/*` rule (`max-age=86400, stale-while-revalidate=604800`). It is not immutable and has no stale-cover risk.
3. **Reinstate only under these conditions.** A `/covers` immutable rule may return only when all three hold:
   - covers are written under content-hashed filenames (the hash changes whenever the bytes change);
   - the writer and its path are named in an ADR;
   - the rule is tested against a real published cover.

## Consequences / Tradeoffs

- Covers, if they are ever added, will not be cached for a year until the conditions above are met. This costs nothing today, because no covers are served.
- The config now has one cache rule instead of two that disagreed in scope.
- Failure mode to watch: a future cover pipeline that writes to a fixed path and copies the old rule. Reinstatement conditions above exist to stop that.

## Sources

- Commit `3a62bff` (`git show 3a62bff`).
- `docs/agent_ledger.jsonl` line 686 ("Task 3").
- Checks listed under Context, run 2026-10-28.
