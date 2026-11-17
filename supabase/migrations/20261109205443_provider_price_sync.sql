-- Reconciled 2026-11-17 from production supabase_migrations.schema_migrations (version 20261109205443); SQL as applied.
create table if not exists public.provider_price_sync (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references public.products(id) on delete cascade,
  provider            text not null check (provider ~ '^[a-z0-9_-]{2,32}$'),
  price_version       integer not null check (price_version > 0),
  target_cents        integer not null check (target_cents > 0),
  currency            text not null default 'USD' check (currency = 'USD'),
  status              text not null default 'pending' check (status in ('pending', 'synced', 'failed')),
  attempts            integer not null default 0 check (attempts >= 0),
  last_error          text,
  created_at          timestamptz not null default now(),
  synced_at           timestamptz,
  -- Keyed on a monotonic version, not on the amount: a price may return to an earlier value and still get a new row.
  unique (product_id, provider, price_version)
);

-- Clients get nothing. Argon F10: the table must not be reachable through the API roles.
revoke all on public.provider_price_sync from anon, authenticated;

create index if not exists provider_price_sync_pending_idx
  on public.provider_price_sync (created_at) where status <> 'synced';

alter table public.provider_price_sync enable row level security;
-- No policies: deny-by-default for anon and authenticated. The service role bypasses RLS by design.
