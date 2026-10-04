-- Idempotent adjustment_id_collision flags.
-- The billing webhook answers a real adjustment-id collision with a retryable 503, so the provider
-- redelivers; without a dedupe key every redelivery would append another MANUAL_REVIEW_REQUIRED_REFUND
-- row. audit_log is append-only (no upsert/update), so uniqueness is enforced with a partial unique
-- index; the app treats the resulting 23505 as "already flagged" (payments/src/ledger.ts).
-- Scoped to collision flags only: other manual-review reasons are unaffected.
-- Safe: no existing audit_log row carries reason adjustment_id_collision (new reason in this release).
-- Rollback: drop index public.audit_log_collision_flag_uniq;

create unique index if not exists audit_log_collision_flag_uniq
  on public.audit_log (
    (details->>'provider'),
    (details->>'adjustment_id'),
    (details->>'event_type'),
    (details->>'reason')
  )
  where event = 'MANUAL_REVIEW_REQUIRED_REFUND'
    and details->>'reason' = 'adjustment_id_collision';
