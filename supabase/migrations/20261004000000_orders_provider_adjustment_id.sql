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

notify pgrst, 'reload schema';
