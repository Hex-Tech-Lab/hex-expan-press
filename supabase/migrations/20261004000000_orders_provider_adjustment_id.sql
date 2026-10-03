-- Migration: 20261004000000_orders_provider_adjustment_id.sql
-- Description: Persist Paddle adjustment ids on refund/refund_reversal order rows
-- Rationale: Webhook replay dedupe for chargebacks: adjustment.created and
-- adjustment.updated share ONE adjustment id, and the existing
-- (provider, sale_id, event_type) unique index cannot tell a replayed chargeback
-- from a new one. Nullable: sale rows never carry an adjustment id.

alter table public.orders
  add column if not exists provider_adjustment_id text;

create unique index if not exists orders_provider_adjustment_id_uniq
  on public.orders (provider, provider_adjustment_id)
  where provider_adjustment_id is not null;

-- Admin queue + manual-review reader filter on event and page newest-first;
-- WEBHOOK_503_RETRYING rows accumulate, so index the access path.
create index if not exists audit_log_event_at_idx
  on public.audit_log (event, at desc, id desc);

-- Rollback: drop index public.audit_log_event_at_idx;
--           drop index public.orders_provider_adjustment_id_uniq;
--           alter table public.orders drop column provider_adjustment_id;

notify pgrst, 'reload schema';
