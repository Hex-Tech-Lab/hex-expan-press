-- Migration: 20260927000200_orders_ledger.sql
-- Description: Financial orders ledger for persistent, serverless-safe webhook storage and audit trail

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  sale_id text not null,
  product_id text not null,
  creator_id text not null,
  amount_usd numeric(10,2) not null,
  creator_split_pct numeric(5,2) not null,
  creator_split_usd numeric(10,2) not null,
  our_split_usd numeric(10,2) not null,
  currency text not null default 'usd',
  event_type text not null default 'sale' check (event_type in ('sale', 'refund')),
  email_hash text,
  attribution_id text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (provider, sale_id, event_type)
);

-- Indexes for fast lookups and idempotency checks
create index if not exists orders_lookup_idx on public.orders (provider, sale_id);
create index if not exists orders_product_idx on public.orders (product_id);
create index if not exists orders_creator_idx on public.orders (creator_id);
create index if not exists orders_attribution_idx on public.orders (attribution_id);

-- RLS
alter table public.orders enable row level security;

-- Service role has full unrestricted access (webhooks / backend ledger)
create policy "service_role full access on orders"
  on public.orders
  for all
  using (auth.role() = 'service_role' or current_user = 'service_role')
  with check (auth.role() = 'service_role' or current_user = 'service_role');

-- Creators can read their own orders (by creator_id match)
create policy "creators read own orders"
  on public.orders
  for select
  using (
    exists (
      select 1 from public.creator_users cu
      where cu.user_id = auth.uid()
        and cu.creator_id::text = orders.creator_id
    )
  );

-- Reload PostgREST schema cache
notify pgrst, 'reload schema';
