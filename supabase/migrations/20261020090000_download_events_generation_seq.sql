-- Migration: Database sequence for monotonic download_events link_generation allocation
-- Replaces raw clock timestamp default with a persistent sequence initialized past any existing generation,
-- and adds an index on audit_log for fast delivery confirmation lookups.

create sequence if not exists public.download_events_link_generation_seq;

select setval(
  'public.download_events_link_generation_seq',
  greatest(
    coalesce((select max(link_generation) from public.download_events), 0),
    (extract(epoch from clock_timestamp()) * 1000)::bigint
  ) + 1
);

alter table public.download_events
  alter column link_generation set default nextval('public.download_events_link_generation_seq');

create index if not exists audit_log_delivery_confirmed_sale_id_idx
  on public.audit_log ((details->>'sale_id'))
  where event = 'DELIVERY_LINK_SENT';
