-- Buyer delivery (launch blocker, item 3). One row per link issued and one per
-- download served. The download token itself is never stored, only its sha256.
-- Issuance is once per sale: the partial unique index makes a webhook retry a no-op.
-- RLS is on with no policies, so only the service role can read or write.

create table if not exists public.download_events (
  id          bigint generated always as identity primary key,
  sale_id     text        not null,
  product_id  uuid        not null references public.products(id),
  token_hash  text        not null check (token_hash ~ '^[0-9a-f]{64}$'),
  event_type  text        not null check (event_type in ('link_issued', 'download_completed')),
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

create unique index if not exists download_events_one_link_per_sale
  on public.download_events (sale_id)
  where event_type = 'link_issued';

create index if not exists download_events_token_hash_idx
  on public.download_events (token_hash);

alter table public.download_events enable row level security;

comment on table public.download_events is
  'Buyer download links and served downloads. Service role only (RLS on, no policies). Stores token hashes, never tokens.';

-- Private bucket for buyer release files. Objects are uploaded by the release process only.
-- Review copies stay in review-pdfs and are never served to buyers.
insert into storage.buckets (id, name, public)
values ('release-files', 'release-files', false)
on conflict (id) do nothing;
