# Proposed ADR — Allocate download link generations in the database

**Status:** Proposed (not accepted; the number is assigned on acceptance, the next free one after 0064; 0062 is absent from `docs/adr/`)
**Date:** 2026-10-28
**Supersedes:** the in-process generation counter that sets `link_generation` in `payments/src/delivery.ts` (`nextGeneration`, lines 30-40; calls at 113 and 124)
**Superseded-by:** —

## Context

`deliverSale` picks each download link's `link_generation` in the application process. The counter is a module-level variable (`payments/src/delivery.ts:30-40`). It is monotonic only inside one process, and serverless instances do not share it.

The database already has a sequence default for the same column (`supabase/migrations/20261020090000_download_events_generation_seq.sql:5, 7-13, 15-16`). It is bypassed. The adapter writes `link_generation` whenever the value is defined (`delivery.ts:242-243`), and `deliverSale` always defines it (`delivery.ts:113-114`).

Collisions are a backstop, not the main guard. The Redis sale lock `lock:sale:{provider}:{saleId}` serialises deliveries for one sale (`src/use_cases/billing/process_billing_webhook.ts:465-466`). The lock is mandatory in production (`payments/src/webhook_core.ts:130-134`). No production collision was found in the repo. Production logs were not checked.

## Problem

1. **The application allocates the generation.** The database cannot guarantee uniqueness across processes. The sequence exists and is unused.
2. **Collisions are retried locally, up to 3 attempts.** On a `(sale_id, link_generation)` conflict the adapter returns `false` (`delivery.ts:247`). `deliverSale` then advances its local counter and retries (`delivery.ts:118-125`). After three failed inserts it throws (`delivery.ts:128-130`), so the webhook answers 500 and the provider retries the whole sale.
3. **The adapter cannot return the generated value.** The insert at `delivery.ts:245` has no returning select, so the application cannot read back what the database chose. The `DeliveryDb.recordLinkIssued` contract returns only a boolean (`delivery.ts:57-63`).
4. **The unique key is per generation, not per sale.** The one-link-per-sale index was dropped (`supabase/migrations/20261019180000_download_events_generation_key.sql:4`). The database therefore does not limit live links per sale and does not block two confirmed deliveries of one sale. Those rest on the Redis lock and the `audit_log` check (`delivery.ts:107`, `delivery.ts:122`, `delivery.ts:164-165`).

## Current schema facts (verified in the repo, live state not verified)

| Fact | Source |
|---|---|
| Original unique key: one `link_issued` row per sale (partial index on `sale_id`) | `supabase/migrations/20261015120000_download_events.sql:16-18`, dropped by `20261019180000...:4` |
| `link_generation` added with an epoch-microsecond default expression (times 1,000,000) | `supabase/migrations/20261019180000_download_events_generation_key.sql:6-7` |
| Current unique key: `(sale_id, link_generation)` where `event_type = 'link_issued'` | `supabase/migrations/20261019180000_download_events_generation_key.sql:9-11` |
| Sequence `download_events_link_generation_seq`, default `nextval`, starts past the max or now in ms | `supabase/migrations/20261020090000_download_events_generation_seq.sql:5, 7-13, 15-16` |
| `expires_at` not-null check for `link_issued` | `supabase/migrations/20261018120000_download_events_link_expiry_check.sql:4-6` (its header says it was not applied from its branch) |
| Only token hashes are stored, never tokens | `supabase/migrations/20261015120000_download_events.sql:2, 10` |

The only migrations that define a unique key on `download_events` are `20261015120000` (original, dropped) and `20261019180000` (current). `20261020090000` defines no unique key. There is no issuance identifier column (no intent or idempotency key). It does not exist today, and this ADR does not assume one.

The app uses milliseconds (`Date.getTime`, `delivery.ts:36-40`, `111`). The epoch-microsecond default at `20261019180000:7` is therefore on a different scale. See Risk R1.

## Decision (proposed)

1. **The database allocates `link_generation`.** The insert omits `link_generation`. The column default (`nextval` on the sequence) supplies it. The adapter reads the value back with a returning select on the insert and returns it to `deliverSale`.
2. **Only the sequence assigns generations.** The application never computes one. The production path of `nextGeneration` and the local counter (`delivery.ts:30-45`) is removed. Tests that reset it are updated in the same change.
3. **A conflict is a typed result, not a silent `false`.** A `23505` on `(sale_id, link_generation)` becomes a `conflict` result. Any other error still throws. A sequence cannot produce a duplicate for new rows, so the conflict path guards against a future writer that sets the value explicitly. Use a plain insert, not `ON CONFLICT DO NOTHING`. DO NOTHING returns no row and would hide a lost insert.
4. **Retry semantics. Proposed: every delivery invocation gets a fresh generation and a fresh token (Option A).** Collision retries within one invocation get a fresh generation but reuse that invocation's token and hash. A later delivery invocation creates a new token. This is the current behaviour (`delivery.ts` collision loop), pinned by `payments/test/delivery_retry_trade_off.test.ts`. The database stores only token hashes, so a reused link cannot be re-sent without a new secret or a schema change.

   | Option | For | Against |
   |---|---|---|
   | A. Fresh generation and token per delivery invocation (proposed) | No new state. Matches pinned tests. Retries are never blocked. | Several valid links per sale. A leaked earlier link stays valid until expiry. The count is bounded only by the retry count. |
   | B. Reuse the generation for the same issuance intent | One live link per sale. | Needs the token again. Either store the token (breaks the hash-only policy in `20261015120000:2`) or derive it from a server secret (new secret, rotation, and a leak exposes every link). Needs an issuance key column that does not exist. |
   | C. Reuse, and enforce one live link per sale in the database (a partial unique index on `sale_id`) | Strongest database guarantee. | Reverses `20261019180000`. An ambiguous-send retry needs a replacement path. The release path (`delivery.ts:157`) becomes the only way to re-issue. |

## Idempotency

- **Issuance identifier: not needed for Option A.** Sale identity (`sale_id`) plus generation is the key. Sale-level idempotency stays with the Redis lock and the `DELIVERY_LINK_SENT` audit row. An issuance identifier is needed only for Option B, and it does not exist today.
- **What the database must enforce now:** unique `(sale_id, link_generation)` on `link_issued` (exists). A generation from the sequence, non-null (default exists, bypassed). `expires_at` not-null for `link_issued` (check file exists, not applied from its branch).
- **What it does not enforce, and will not after this ADR under Option A:** at most one live link per sale, and at most one confirmed delivery per sale. Those stay with the lock unless Option C is chosen.
- **On conflict:** plain insert. A `23505` maps to `conflict`. Any other error throws, as today (`delivery.ts:248`).

## Migration path (boolean to result type)

The webhook entry point does not change. `deliverSaleForWebhook` (`payments/src/delivery.ts:206-214`) keeps its `void` return and its throws. Its callers, `src/use_cases/billing/process_billing_webhook.ts:482` and `:523`, need no edit. The port change is internal to `delivery.ts`.

1. **Result type.** Add `issued` (with `linkGeneration`) and `conflict`. Change `DeliveryDb.recordLinkIssued` (`delivery.ts:57-63`) to return it. Update the loop at `delivery.ts:118-126`. This is the only production caller.
2. **Adapter.** `supabaseDeliveryDb.recordLinkIssued` (`delivery.ts:232-249`) omits `link_generation`, reads back the generated value, and maps `23505` to `conflict`. A missing value throws. It must not fall back to a local counter, or the emailed token could diverge from the stored row (R4).
3. **Test fakes to update in the same change:** `payments/test/delivery.test.ts:15, 199, 225`; `payments/test/delivery_db_adapter.test.ts:49-92`; `payments/test/delivery_retry_trade_off.test.ts:28, 82, 115, 137`; `payments/test/delivery_block_outcome.test.ts:13`.
4. **Remove** `nextGeneration` and `resetLastGenerationForTest` (`delivery.ts:30-45`) once no test imports them.

Rollback of the code is a single revert of this change.

## Test plan

### Available harnesses

- **PGlite** (`@electric-sql/pglite` 0.5.8, `package.json:49`). Used by `web/src/lib/__tests__/launch-gate-sql-parity.test.ts:7, 97`. It reads migration files by name (`:11`) and runs real SQL. Context7: PGlite is single-user and single-connection, and `exec` uses the simple protocol without parameters. That test also notes that PGlite ignores isolation levels (`:149`).
- **Mock supabase chain** in `payments/test/delivery_db_adapter.test.ts:22-23`. It checks the insert payload and does not reach a database.
- **Fakes** in `payments/test/delivery.test.ts` and `payments/test/delivery_retry_trade_off.test.ts`. They simulate collisions in memory.
- **Not present:** no real Postgres service is wired into the repo. Supabase is remote only (CLAUDE.md). Local port 54322 must not be probed.

### Tests to add

1. The migration chain applies in order on PGlite, through `20261020090000`. The unique index and the sequence default exist. *(PGlite, feasible.)*
2. An insert without `link_generation` takes a sequence value, and the returning select returns that value. *(PGlite, feasible.)*
3. A duplicate `(sale_id, link_generation)` raises `23505`, and the original row is unchanged (same `token_hash` and `created_at`). *(PGlite, feasible.)*
4. Two `link_issued` rows for one sale with different generations both succeed. This documents that the database allows several links per sale. *(PGlite, feasible.)*
5. A rolled-back insert consumes a sequence value, and the gap is accepted. Context7 confirms `nextval` is not rolled back. *(PGlite, feasible.)*
6. The adapter maps `23505` to `conflict`, and other errors throw. *(Mock chain, feasible.)*
7. The adapter returns the database-assigned generation from the read-back, and a missing value throws. *(Mock chain, feasible.)*
8. Concurrency: N parallel deliveries for one sale, driven through the lock-bearing entrypoint `process_billing_webhook` (which takes the Redis sale lock before `deliverSaleForWebhook`). Calling `deliverSale` directly would skip the lock and prove nothing about it. On the success path, exactly one delivery inserts a link row and is confirmed. After an ambiguous send, a retry can insert a second row (`delivery.ts` retry path). The others either fail to acquire the lock or observe the confirmation before inserting. *(Needs a real Postgres; PGlite is single-connection.)*
9. Concurrent inserts from separate connections to real Postgres at read committed: no duplicate `(sale_id, link_generation)`. *(Missing harness.)*
10. Distinct generations: consecutive or parallel invocations for one sale return pairwise-distinct generation values. This is a sequence property, kept separate from test 8's single-confirmation check. *(Sequential form on PGlite is feasible. True concurrency needs a real Postgres.)*

**What is missing for tests 8 and 9:** a real Postgres in CI (a service container), or a separate Supabase branch. A Supabase branch is remote, billed, and needs approval. A PGlite multiplexer is not a faithful isolation test.

## Risks and rollback

- **R1. Scale mismatch.** The `20261019180000:7` default is in epoch microseconds, while the app uses milliseconds (`delivery.ts:36-40`). Existing rows carry microsecond values. The sequence starts past the max, so new values are also microsecond-scale. Any code that compares generation to a millisecond timestamp would break. The repo has no such consumer (grep found none outside `delivery.ts` and its tests). Ordering stays monotonic inside the sequence.
- **R2. Gaps.** `nextval` is never rolled back, and `INSERT ... ON CONFLICT` consumes values before detecting a conflict (Context7, PostgreSQL docs). Accepted. The generation is not a gapless or financial number.
- **R3. Live state unknown.** Whether the sequence default and the `(sale_id, link_generation)` index are applied in production is not verified. Check with `list_migrations` before implementation.
- **R4. Read-back dependency.** A missing returned value must fail the delivery, not fall back to a local value.
- **R5. Several valid links (Option A).** Earlier links stay valid until expiry, as today.
- **R6. The lock is still the real per-sale guard.** This ADR does not change it. If the lock TTL expires while a delivery is in flight, a second delivery can run, and the database will not block it under Option A.
- **Rollback.** Revert the adapter and `deliverSale` changes. The explicit-generation path is in git history. Old code always sends a value, so the schema default can stay. If needed, `alter column ... drop default` restores the pre-sequence state. No data migration is needed, and the index is unchanged.

## Open decisions for the founder

1. Retry semantics: a fresh link per delivery invocation (Option A), or one live link per sale (B or C)?
2. Should the database enforce one live link per sale again, reversing `20261019180000` (Option C)?
3. Approve a real-Postgres concurrency harness: a CI service container, or a separate Supabase branch?
4. Accept the mixed microsecond and millisecond scale and the sequence gaps, or re-base the sequence?
5. Keep the 3-attempt conflict loop as a guard, or remove it once the sequence is the only writer?
6. Who confirms the live sequence default and index before implementation?

## Not verified

- Live database state (sequence default, index, unique key). Remote only, not checked from this worktree.
- Production collision frequency. Sentry and logs were not checked.
- Whether a returning select on the Supabase insert yields the generated value. The adapter tests use a mock chain, and Context7 covers Postgres and PGlite, not supabase-js.
- Whether `RETURNING` combined with `ON CONFLICT DO NOTHING` returns no row on conflict. Context7 did not state this. The design avoids the combination.
- Related ADR `0057-webhook-idempotency-and-fail-closed.md` was not reviewed in full.

## Sources

- `payments/src/delivery.ts` (lines cited above; the working copy in this worktree, which has uncommitted changes)
- `supabase/migrations/20261015120000_download_events.sql`, `20261018120000_download_events_link_expiry_check.sql`, `20261019180000_download_events_generation_key.sql`, `20261020090000_download_events_generation_seq.sql`
- `src/use_cases/billing/process_billing_webhook.ts:465-466, 482, 523`
- `payments/src/webhook_core.ts:130-134, 139-140`
- Context7, `/websites/postgresql` (sequences, `INSERT ... ON CONFLICT`) and `/electric-sql/pglite` (single connection, `exec`)
