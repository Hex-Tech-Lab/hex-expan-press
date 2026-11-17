-- Single buyer send guard (Option A) + monotonic fencing token guards (Option B).
-- Do NOT apply from code/tests; applied via normal migration deploy.
--
-- Option A: public.delivery_sends enforces one send row per (provider, sale_id, send_kind).
-- Workers insert ('claimed') with ON CONFLICT DO NOTHING before issuing links or sending email,
-- transition to ('sent') after clean send, and keep ('claimed') on ambiguous send errors so
-- retries never send duplicate buyer emails (a claimed-but-undelivered email is preferred over
-- a duplicate).
--
-- Option B: delivery_sends.fence and orders.fence record the monotonic Redis INCR token from
-- the webhook lock; conditional updates (`where ... and fence <= $1`) and BEFORE UPDATE triggers
-- reject stale-token writes from workers whose lock TTL expired.

create table if not exists public.delivery_sends (
  sale_id    text        not null,
  provider   text        not null,
  send_kind  text        not null,
  fence      bigint      not null default 0,
  state      text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint c
      join pg_catalog.pg_class t on t.oid = c.conrelid
      join pg_catalog.pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'delivery_sends'
       and c.contype = 'p'
  ) then
    alter table public.delivery_sends
      add constraint delivery_sends_pkey primary key (provider, sale_id, send_kind);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint c
      join pg_catalog.pg_class t on t.oid = c.conrelid
      join pg_catalog.pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'delivery_sends'
       and c.conname = 'delivery_sends_state_check'
  ) then
    alter table public.delivery_sends
      add constraint delivery_sends_state_check check (state in ('claimed', 'sent'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint c
      join pg_catalog.pg_class t on t.oid = c.conrelid
      join pg_catalog.pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'delivery_sends'
       and c.conname = 'delivery_sends_fence_nonneg'
  ) then
    alter table public.delivery_sends
      add constraint delivery_sends_fence_nonneg check (fence >= 0);
  end if;
end
$$;

alter table public.delivery_sends enable row level security;
revoke all on table public.delivery_sends from public, anon, authenticated;
grant select, insert, update, delete on table public.delivery_sends to service_role;

comment on table public.delivery_sends is
  'Single-send claim/sent guard and fencing token per (provider, sale_id, send_kind). Service role only (RLS on, no policies).';

-- Monotonic fencing column on public.orders for Option B ledger write protection.
alter table public.orders
  add column if not exists fence bigint not null default 0;

do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint c
      join pg_catalog.pg_class t on t.oid = c.conrelid
      join pg_catalog.pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'orders'
       and c.conname = 'orders_fence_nonneg'
  ) then
    alter table public.orders
      add constraint orders_fence_nonneg check (fence >= 0);
  end if;
end
$$;

create or replace function public.delivery_sends_fence_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.fence < old.fence then
    raise exception 'stale fence token on public.delivery_sends: stored %, got %', old.fence, new.fence
      using errcode = '40001';
  end if;
  if old.state = 'sent' and new.state = 'claimed' then
    raise exception 'invalid state transition on public.delivery_sends: sent cannot revert to claimed'
      using errcode = '23514';
  end if;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end
$$;

revoke all on function public.delivery_sends_fence_guard() from public, anon, authenticated;

drop trigger if exists delivery_sends_fence_guard_trg on public.delivery_sends;
create trigger delivery_sends_fence_guard_trg
  before update on public.delivery_sends
  for each row execute function public.delivery_sends_fence_guard();

create or replace function public.orders_fence_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.fence < old.fence then
    raise exception 'stale fence token on public.orders: stored %, got %', old.fence, new.fence
      using errcode = '40001';
  end if;
  return new;
end
$$;

revoke all on function public.orders_fence_guard() from public, anon, authenticated;

drop trigger if exists orders_fence_guard_trg on public.orders;
create trigger orders_fence_guard_trg
  before update on public.orders
  for each row execute function public.orders_fence_guard();

notify pgrst, 'reload schema';
