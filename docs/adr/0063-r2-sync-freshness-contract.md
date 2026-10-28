# 0063 — R2 Sync Freshness and Overwrite Contract

**Status:** Accepted (2026-10-27, founder decision: "proceed with A + B as recomm")
**Date:** 2026-10-27
**Supersedes:** the presence-only skip in `scripts/sync-supabase-to-r2.ts` (merged PR 105), which treated any successful HEAD as "already synced" and wrote with an unconditional PUT.
**Superseded-by:** —

## Context

The Supabase-to-R2 sync skipped any object that already existed in R2, with no comparison of versions. A changed source at the same key therefore stayed stale in R2 indefinitely. Its PUT was unconditional, so two overlapping runs could let older bytes land last. Verified in code on 2026-10-27: `sync-supabase-to-r2.ts:221-225` (presence skip) and the unconditional PUT in `putR2Object`. Cloudflare's R2 documentation confirms that `PutObject` evaluates `If-Match` and `If-None-Match` atomically against the committed object, and that concurrent `If-None-Match: *` writes yield one winner and `412` to the rest.

## Decision

1. **Source-version marker.** Every object written by the sync stores the Supabase Storage ETag of its source in the metadata header `x-amz-meta-supabase-etag`. The ETag comes from the Supabase listing (`metadata.eTag`).
2. **Skip rule.** The sync skips an object only on an exact match between the stored marker and the listed source ETag. Presence alone never skips.
3. **Conditional writes.**
   - Absent object: `PUT` with `If-None-Match: *` (create-once).
   - Existing object: `PUT` with `If-Match` set to R2's own ETag, read by the HEAD just before the write (refresh).
   - A `412` response is a failed run item with the error "R2 precondition failed (concurrent write); re-run sync". The sync does not retry or overwrite inside the same run.
4. **Signed preconditions.** The conditional headers and the `x-amz-meta-*` header are included in the SigV4 signed headers, so R2 authenticates them. The host-only signature used before this decision is not sufficient for them.
5. **Inconclusive reads never mean absence.** `statR2Object` returns `exists: false` only on a confirmed 404. Any other status or a network error throws, and the sync records a failure without writing.
6. **Unversioned input refused.** A listed object with no ETag is not synced. An R2 object with no ETag is not overwritten, because the write could not be conditioned.
7. **Counters.** `uploaded` increments on a successful PUT, before verification. `verified` increments only when a post-write HEAD shows the expected source marker. A successful PUT whose verification fails counts as `uploaded: 1, verified: 0, failed: 1`.
8. **Missing-marker policy.** Objects written before this decision carry no marker. They are refreshed once, with `If-Match`, and carry the marker from then on. Consequence: one re-upload per legacy object, then none.

## Consequences / Tradeoffs

- **Easier:** a changed source is picked up at the same key. Concurrent runs cannot silently overwrite a newer object.
- **Harder:** the adapter now exposes `statR2Object` (ETags and marker) alongside the boolean `headR2Object`, which remains for existing callers.
- **Accepted cost:** every run issues one HEAD per listed object, as before, and one additional HEAD after each write.
- **Known failure mode to watch:** a `412` in a run means another writer touched the same key. The run reports it as failed so a human re-runs it. It does not guess which writer is correct.
- **Not verified live in this decision.** The conditional-write behaviour is confirmed from Cloudflare's documentation and checked by unit tests against the request shape. It has not been exercised against a real bucket. A live check against a scratch key, using credentials the founder approves, is the next verification step.

## Sources

- `scripts/sync-supabase-to-r2.ts` (freshness loop, counters) and `src/adapters/storage/r2.adapter.ts` (`statR2Object`, `putR2ObjectIf`, signed headers).
- Cloudflare R2 documentation, "Consistency" (conditional writes) and "S3 API extensions" (conditional operations in `PutObject`), checked 2026-10-27.
- PR 105 review, items on stale skip, concurrency, counters, and missing marker. Verdicts recorded in `docs/agent_ledger.jsonl`.
