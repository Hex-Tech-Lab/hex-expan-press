# THOS — Sprint 10 cloud handover (2026-10-03)

Written for a **Claude Code cloud session with no OC/AGY**: you do the build work yourself.
The local session resumes Tuesday 2026-10-06 ~02:00. Technical state only; this repo is public.

## Read first
`CLAUDE.md`, then `AGENTS.md`. Ignore the AGENTS.md OC/AGY routing rules while you're in the cloud: there's no delegation.

## State
- `master` is at `4153628` (PR #69 merged and deployed; probes and Sentry were clean).
- This branch, `feature/ledger-collision-hardening`, holds **WIP from OC**. Its last run was stopped at the cutoff.
- WIP tests: billing suite **82/83 pass**. The one failure is
  `process_billing_webhook.test.ts > refund contention while the durable lookup fails → rejected, never acknowledged`. It times out at 5 s. The mock or wait in that test doesn't fit the new conflicting-row lookup path. **Fix the test or the code; don't raise the timeout.**

## Remaining tasks (in order)
1. **The 23505 collision contract**, in `src/use_cases/billing/process_billing_webhook.ts`: both catch blocks around `appendRefund` and `appendRefundReversal`. **Check the WIP against this before trusting it.**
   - On an adjustment-id unique violation, load the conflicting row with `findByProviderAdjustmentIdAsync(provider, adjustmentId, eventType)`.
   - Return 200 "duplicate" **only** when all of these hold:
     - the row exists;
     - `sale_id` matches;
     - the amount in cents matches (or the event has no total);
     - the currency matches (or the event has none).
   - In every other case (no row, the lookup throws, or a mismatch):
     - if a row exists but mismatches, call `flagRefundForManualReview` with reason `adjustment_id_collision` (add it to the schema in `payments/src/ledger.ts`);
     - then throw a retryable error, so the response is a 503.
2. **`Retry-After` on every 503** from the billing webhook route, including the generic `httpStatus: 503` path. Take the value from the settings registry (`payments/src/settings_registry.ts`), never a literal.
3. **Migration guard for the e-sign signer.** Add a CHECK that `consents.signed_by IS NOT NULL`. This is defense in depth: the column is already NOT NULL live.
   - Number it after the newest file in `supabase/migrations`.
   - Run `list_migrations` live first to confirm what's already applied.
4. **A data-safe rollback note** for `20261004000100_orders_adjustment_id_per_event.sql`. The old single-column unique index **can't** be recreated once a refund and its reversal share an adjustment id, so the rollback has to deal with that data first. Put the note in the migration header.
5. Delete any `trace*.test.ts` scratch files before committing.

## Gate before merge (no skips)
1. Typecheck, lint, then `pnpm test`.
2. Run the skills in this order:
   1. `/qa-intel`, full plus diff.
   2. `/code-reviewer`, the free first sweep.
   3. The graph skills (`build-graph`, `review-delta`).
   4. `/simplify`.
   5. `/code-review` **last**.
3. Apply the migration live with the Supabase connector's `apply_migration`. Use it for DDL; don't run DDL through `execute_sql`.
4. Open the PR through `/pr-review-workflow`. `master` has 5 required strict checks: wait for them and for the review bots, and address their comments.
5. Merge, wait for the Vercel deploy, then run the probes. Expected results:
   - home page → 200;
   - unsigned billing webhook → 400;
   - unsigned e-sign webhook → 400;
   - checkout → 500 (still gated);
   - consents page → redirect;
   - admin API → 401.
6. Check Sentry after the deploy, and before you say "done".

## Hard rules
- **Never run tests with live keys loaded.** Ledger tests write to production `public.orders`.
- Anything under `data/`, and any strategic, legal or business material, never goes in git. Run `git check-ignore` before staging a new path.
- No hard-coding: every timeout, tolerance, limit, URL and id comes from the settings registry.
- Don't trust claims in handovers, including this one, without checking them. Before trusting migrations, list the live `pg_proc` overloads.
- Never print key values.
- The Paddle connector points at the **wrong account**. The live Paddle proof (simulation) needs `PADDLE_API_KEY` set in the cloud environment, or it waits for the local session on Tuesday.

## Cloud environment variables (names only, if the founder adds them)
- **Optional, for the Paddle proof:** `PADDLE_API_KEY`, `PADDLE_ENVIRONMENT`.
- **Not needed for the work above:** Supabase, Vercel and Sentry go through connectors.

## Open after this sprint
- **Founder:** one end-to-end live Firma C3 signing test.
- **Founder:** legal entity name and address for the `[FILL]` placeholders in `web/public/privacy.html` and `web/public/terms.html`.
- Sprint 11:
  - Zod re-validation at the `orders.upsert()` boundary.
  - Move the `orders` USD floats to integer cents.
