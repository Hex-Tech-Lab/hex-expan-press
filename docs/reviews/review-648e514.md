# Review of master 648e514 (manual run; review skills not available)

Scope: commits c79e13c..648e514 (18 commits). Read-only checks run in a detached worktree at 648e514.
Skills `verification-before-completion`, `pr-review-workflow`, `pr-review-toolkit:review-pr` were invoked via the Skill tool and returned "Unknown skill". Their steps were done by hand. Sub-agent review was NOT run.

## 1. Claim reproduction (verification-before-completion, manual)

| Claim | Command | Result |
|---|---|---|
| Root typecheck clean | `pnpm exec tsc --noEmit` | exit 0 |
| Web typecheck clean | `pnpm --dir web exec tsc --noEmit` | exit 0 |
| Root lint clean | `pnpm lint` | exit 0 |
| Web lint clean | `pnpm --dir web run lint` | exit 0 |
| Full suite green ("green on full suite", 4f01eb6) | `pnpm exec vitest run` | exit 0; 77 files, 998 passed, 1 skipped |
| Microsecond default in b85a75a | read `supabase/migrations/20261019180000_download_events_generation_key.sql:7` | confirmed `extract(epoch from clock_timestamp()) * 1000000` |
| Sequence replaces raw clock default ("Replaces raw clock timestamp default") | read `supabase/migrations/20261020090000_download_events_generation_seq.sql:14-16` | confirmed `set default nextval(...)`. **Supersedes b85a75a for new rows.** |
| Index for "fast delivery confirmation lookups" (seq migration header) | read `...seq.sql:18-20` vs `payments/src/delivery.ts:263-272` | **Not met.** Index is on `(details->>'sale_id')`; query uses `.contains("details", {sale_id})`. Index cannot serve the containment predicate. Not reproduced with EXPLAIN (no DB write allowed). |
| Dub short-link bounded (b85a75a-era review finding) | read `payments/src/delivery.ts:180` | confirmed `AbortSignal.timeout(...)` |
| productForAlias exact match (no PostgREST splice) | read `payments/src/delivery.ts:220-233` | confirmed `.eq(column, alias)` per column |

## 2. PR review matrix (manual; gh GraphQL blocked, REST used)

| PR | State | Merged (UTC) | Head | Reviews on record | Checks on head | Verdict |
|---|---|---|---|---|---|---|
| #110 | closed, merged by THeX | 2026-10-25T20:42:19Z | c3869ac | CodeRabbit APPROVED 2026-10-25T20:41:37Z; CodeRabbit CHANGES_REQUESTED 2026-10-21T18:53:33Z (superseded); TechHypeXP COMMENTED 2026-10-25T20:40:23Z; Sourcery APPROVED 2026-10-20T16:31:15Z | all success; cubic neutral | OK. Human approval not on record. Trivial outside-diff note on resolved-`getSession` error case (proxy.ts) was not addressed in-branch. |
| #111 | closed, merged | 2026-10-25T20:47:32Z | 91ca0cb | Sourcery COMMENTED 2026-10-25T20:48:14Z (**after merge**) | all success; cubic neutral | **Merged with no approving review and no CodeRabbit review.** Process gap, not a code failure. |

## 3. Code review (manual pass; sub-agents not run)

| Sev | file:line | Finding |
|---|---|---|
| P1 | `payments/src/delivery.ts:136-156` (confirm after send at `:166`) | At-least-once email. Send succeeds, then `confirmDelivery` fails → next retry sends a second email. Documented in comments, but a real duplicate-send path. Ambiguous send failures also leave the link row, so a retry sends again. |
| P2 | `payments/src/delivery.ts:263-272` vs `supabase/migrations/20261020090000_download_events_generation_seq.sql:18-20` | Index/query mismatch (see §1). Index is unused; `deliveryConfirmed` scans `audit_log` on every delivery. |
| P2 | `payments/src/delivery.ts:109,124,131` | `deliveryConfirmed` runs up to 3x per attempt, each a full scan (see P2 above). |
| P3 | `payments/src/delivery.ts:71,284` | `releaseOrphanedLinks` is dead in production (no caller outside tests). CodeRabbit asked for its removal on #108; not done. |
| P3 | `supabase/migrations/20261019180000_download_events_generation_key.sql:7` | Microsecond default is superseded by `20261020090000` for new rows. Keep, but document the chain. |

No P0 found on the reviewed paths.

## 4. Buyer email path (manual trace)

1. `web/app/api/billing/webhook/route.ts:11` `export const POST = …` (handler factory).
2. `web/app/api/billing/webhook/handler.ts:114-118` WebhookInFlightError → 503 + Retry-After.
3. `web/app/api/billing/webhook/handler.ts:127,155` terminal errors → quarantine.
4. `src/use_cases/billing/process_billing_webhook.ts:482,523` `deliverSaleForWebhook({ saleId, productAlias: productId, buyerEmail })`.
5. `payments/src/delivery.ts:208` `deliverSaleForWebhook` → `deliverSale` (`:99`).
6. `:103` no buyerEmail → `no_email`. `:106` no release file → `no_release_file` (fail closed).
7. `:109` duplicate check. `:115` `nextGeneration` (`:36`, monotonic). `:121` `recordLinkIssued` (23505 → false → retry gen up to 3x).
8. `:136` `createShortLink` → `createDubShortLink` (`:172`, timeout set at `:180`).
9. `:140` `withDeadline(sendEmail)` → `payments/src/email.ts:61` `sendEmail`. `EmailSendError.definite` (`email.ts:23,97`) triggers `releaseLinkIssued` (`delivery.ts:159`).
10. `:166` `confirmDelivery` writes `DELIVERY_LINK_SENT` to `audit_log` **after** send (see P1).

Contract drift: none found between `DeliveryDb` interface (`:55-77`) and `productionDeps` adapter (`:191-290`) beyond the dead `releaseOrphanedLinks` (P3).

## Commands run
- `git fetch -q origin`; `git rev-parse --verify 648e514^{commit}`; `git log --oneline c79e13c..648e514`
- `git worktree add --detach <scratch>/wt-648 648e514`; symlinked `node_modules` (root and web)
- `pnpm exec tsc --noEmit`; `pnpm --dir web exec tsc --noEmit`; `pnpm lint`; `pnpm --dir web run lint`; `pnpm exec vitest run` (all in worktree)
- `gh api repos/Hex-Tech-Lab/hex-expan-press/pulls/{110,111}`, `/reviews`, `/commits/<sha>/check-runs`
- `sed`/`grep` on migrations and `payments/src/*.ts` (read-only)
- No merges, deploys, DB writes, or secrets.
