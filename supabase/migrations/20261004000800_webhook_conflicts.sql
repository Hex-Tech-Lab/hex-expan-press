-- Phase B3 (hostile audit 2026-10-04): durable reconciliation inbox for billing webhook adjustment-id collisions.
-- Before: a refund/reversal whose provider_adjustment_id collides with a NON-matching orders row was answered
--   503 until the provider exhausted its retries; the event itself was never stored, only an audit_log flag.
-- After: the incoming event is stored here (status 'pending') and the webhook answers 202 conflict_pending, which
--   every provider treats as delivered. The event is NOT applied automatically; an operator resolves the row.
-- Design: /mnt/project-files/audit/B3_conflict_pending_design.md (decisions confirmed by K 2026-10-04).
-- Service role only: RLS is on with no policies; the RPC below is the single write path.
-- Rollback: drop function public.record_webhook_conflict(text, text, text, text, jsonb, text, text, bigint, text, jsonb);
--           drop table public.webhook_conflicts;  (then drop function public.webhook_conflicts_guard();)

create table public.webhook_conflicts (
  id                      bigint generated always as identity primary key,
  first_seen_at           timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  delivery_count          integer     not null default 1 check (delivery_count >= 1),
  provider                text        not null check (length(provider) between 1 and 64),
  event_type              text        not null check (event_type in ('refund', 'refund_reversal')),
  sale_id                 text        not null check (length(sale_id) between 1 and 128),
  adjustment_id           text        not null check (length(adjustment_id) between 1 and 128),
  reason                  text        not null check (reason = 'adjustment_id_collision'),
  -- Normalized incoming event only (sale_id, total_cents, currency, occurred_at, refund_id, adjustment_id).
  -- Never the raw provider body and never buyer data.
  incoming                jsonb       not null check (jsonb_typeof(incoming) = 'object'),
  payload_sha256          text        not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  conflicting_sale_id     text        not null,
  conflicting_event_type  text        not null,
  conflicting_amount_cents bigint,
  conflicting_currency    text,
  status                  text        not null default 'pending' check (status in ('pending', 'applied', 'rejected')),
  resolved_at             timestamptz,
  resolved_by             uuid references auth.users (id),
  resolution_note         text,
  constraint webhook_conflicts_resolution_consistent check (
    (status = 'pending' and resolved_at is null)
    or (status <> 'pending' and resolved_at is not null)
  ),
  -- The same redelivery dedupes to one row (delivery_count++); a different payload under the same
  -- adjustment id becomes a second row, which is itself a signal.
  constraint webhook_conflicts_dedupe_uidx unique (provider, event_type, adjustment_id, payload_sha256)
);

create index webhook_conflicts_pending_idx on public.webhook_conflicts (first_seen_at) where status = 'pending';

alter table public.webhook_conflicts enable row level security;
revoke all on public.webhook_conflicts from public, anon, authenticated;

-- Append-mostly (like audit_log): deletes are forbidden; only the redelivery counters and the resolution
-- fields may change, and a resolved row is final.
create or replace function public.webhook_conflicts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'webhook_conflicts rows are never deleted';
  end if;
  if (new.id, new.first_seen_at, new.provider, new.event_type, new.sale_id, new.adjustment_id, new.reason,
      new.incoming, new.payload_sha256, new.conflicting_sale_id, new.conflicting_event_type,
      new.conflicting_amount_cents, new.conflicting_currency)
     is distinct from
     (old.id, old.first_seen_at, old.provider, old.event_type, old.sale_id, old.adjustment_id, old.reason,
      old.incoming, old.payload_sha256, old.conflicting_sale_id, old.conflicting_event_type,
      old.conflicting_amount_cents, old.conflicting_currency) then
    raise exception 'webhook_conflicts: only counters and resolution fields are mutable';
  end if;
  if old.status <> 'pending' and (new.status, new.resolved_at, new.resolved_by, new.resolution_note)
     is distinct from (old.status, old.resolved_at, old.resolved_by, old.resolution_note) then
    raise exception 'webhook_conflicts: a resolved row is final';
  end if;
  return new;
end $$;

create trigger webhook_conflicts_guard_trg
  before update or delete on public.webhook_conflicts
  for each row execute function public.webhook_conflicts_guard();

-- Single write path. The conflict row and the audit_log alert commit together or not at all; the app answers
-- 202 only after this returns an id. The audit insert reuses the existing MANUAL_REVIEW_REQUIRED_REFUND event
-- (so dashboards keep working); audit_log_collision_flag_uniq (20261004000600) dedupes it, hence ON CONFLICT DO NOTHING.
create or replace function public.record_webhook_conflict(
  p_provider                 text,
  p_event_type               text,
  p_sale_id                  text,
  p_adjustment_id            text,
  p_incoming                 jsonb,
  p_payload_sha256           text,
  p_conflicting_sale_id      text,
  p_conflicting_amount_cents bigint,
  p_conflicting_currency     text,
  p_flag_details             jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if not (auth.role() = 'service_role' or current_user = 'service_role') then
    raise exception 'record_webhook_conflict is service-role only';
  end if;

  insert into public.webhook_conflicts (
    provider, event_type, sale_id, adjustment_id, reason, incoming, payload_sha256,
    conflicting_sale_id, conflicting_event_type, conflicting_amount_cents, conflicting_currency
  )
  values (
    p_provider, p_event_type, p_sale_id, p_adjustment_id, 'adjustment_id_collision', p_incoming, p_payload_sha256,
    p_conflicting_sale_id, p_event_type, p_conflicting_amount_cents, p_conflicting_currency
  )
  on conflict on constraint webhook_conflicts_dedupe_uidx
  do update set last_seen_at = now(), delivery_count = public.webhook_conflicts.delivery_count + 1
  returning id into v_id;

  insert into public.audit_log (event, details)
  values ('MANUAL_REVIEW_REQUIRED_REFUND', p_flag_details)
  on conflict do nothing;

  return v_id;
end $$;

revoke all on function public.record_webhook_conflict(text, text, text, text, jsonb, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_webhook_conflict(text, text, text, text, jsonb, text, text, bigint, text, jsonb) to service_role;
