-- Migration: Support multiple issued download links per sale across retries
-- Replaces single-link partial unique index with generation timestamp index

drop index if exists public.download_events_one_link_per_sale;

alter table public.download_events
  add column if not exists link_generation bigint not null default (extract(epoch from clock_timestamp()) * 1000000)::bigint;

create unique index if not exists download_events_sale_id_generation_idx
  on public.download_events (sale_id, link_generation)
  where event_type = 'link_issued';
