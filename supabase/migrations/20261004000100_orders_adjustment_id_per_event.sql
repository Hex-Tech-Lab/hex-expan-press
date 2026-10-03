-- Migration: 20261004000100_orders_adjustment_id_per_event.sql
-- Description: Scope the adjustment-id unique index per event_type.
-- Rationale: a won dispute's refund_reversal may carry the same Paddle adjustment id
-- as the refund it reverses. With (provider, provider_adjustment_id) alone the
-- reversal insert raised 23505 and was swallowed as a replay, so the creator's split
-- was never restored. Replays stay deduped per (provider, id, event_type).
-- Safe: public.orders is empty in production at the time of writing.

drop index if exists public.orders_provider_adjustment_id_uniq;

create unique index if not exists orders_provider_adjustment_id_uniq
  on public.orders (provider, provider_adjustment_id, event_type)
  where provider_adjustment_id is not null;

-- Rollback: recreate the index on (provider, provider_adjustment_id) only.

notify pgrst, 'reload schema';
