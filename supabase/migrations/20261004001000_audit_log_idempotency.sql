-- P2 (external review round / compiled vulnerability list): manual-review flags did a
-- plain insert into audit_log, so every replayed webhook inserted ANOTHER review task
-- (the esign replay pre-check runs flagLegacyProvenance at-least-once on purpose, and
-- the billing DLQ flag is similarly replay-prone). Callers now pass a deterministic
-- idempotency_key; the unique index makes duplicate keys upsert to a no-op.
-- Full unique index, NOT partial: PostgREST's onConflict target cannot infer a
-- partial index's WHERE clause, and NULLS DISTINCT (the default) already gives
-- keyless rows conflict-free inserts — identical semantics, cleaner inference.
-- Backfill: historical duplicate rows are left as-is (append-only audit history).

alter table public.audit_log add column if not exists idempotency_key text;

create unique index if not exists audit_log_idempotency_uidx
  on public.audit_log (idempotency_key);
