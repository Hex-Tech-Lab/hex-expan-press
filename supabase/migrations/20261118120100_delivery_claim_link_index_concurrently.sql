-- PR 136 H1 follow-up: the partial index that serves listStuckDeliveryClaims (state = 'claimed' ordered by created_at).
-- Split from 20261118120000_delivery_claim_link.sql so it can build CONCURRENTLY. A concurrent build does not block writes
-- to public.delivery_sends while it runs, but it cannot run inside a transaction block, so this file holds one statement
-- and no transaction control.
--
-- If the build fails it leaves an INVALID index behind. Drop that index before re-running: IF NOT EXISTS would otherwise
-- skip the rebuild and keep the invalid index.
--
-- Do NOT apply from code or tests; applied via the normal migration deploy.

create index concurrently if not exists delivery_sends_claimed_created_idx
  on public.delivery_sends (created_at)
  where state = 'claimed';
