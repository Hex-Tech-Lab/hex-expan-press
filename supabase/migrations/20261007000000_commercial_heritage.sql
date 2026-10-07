-- Commercial heritage eradication (Sprint 15) — absorb the flat-file commercial
-- state (payments/creators.json, payments/config.duane.json,
-- data/settings/rails.<product>.json, data/settings/terms.json) into Postgres.
-- The database becomes the single source of truth for every commercial
-- decision; the JSON files are ported by scripts/migrate-heritage-json.ts and
-- then deleted.
--
-- Principles carried over from the creator-portal migration (ADR 0048):
--   * RLS on every table; writes go through the service role only.
--   * system_config and creator_terms carry NO client policies at all —
--     anon/authenticated are denied by RLS (same pattern as audit_log);
--     service_role bypasses RLS by design.
--   * Existing rows are never rewritten blindly: products.slug and creators
--     portal state are owned by the portal; heritage columns are additive.

-- ---------------------------------------------------------------------------
-- creators: profile surface from creators.json (hub-page baker input)
-- ---------------------------------------------------------------------------
alter table public.creators
  add column if not exists platform_handles jsonb not null default '{}'::jsonb,
  add column if not exists bio              text,
  add column if not exists bio_source       text,
  add column if not exists photo            text; -- null renders the monogram placeholder; real photo only after likeness-rights agreement

-- ---------------------------------------------------------------------------
-- products: commercial config from config.<creator>.json
-- (id/creator_id/slug/title/release_* already exist from the portal migration)
-- ---------------------------------------------------------------------------
alter table public.products
  add column if not exists store_product_id     text unique, -- provider custom_data key, e.g. "duane_retirement_playbook_v1"
  add column if not exists composite_slug       text unique, -- SKU/internalId namespace: <handle>-<product_slug> (never a URL path)
  add column if not exists site_slug            text unique, -- nested site URL namespace: <handle>/<product_slug>
  add column if not exists description          text,
  add column if not exists price_usd            numeric(10,2) check (price_usd is null or price_usd > 0),
  add column if not exists currency             text not null default 'USD',
  add column if not exists provider             text,
  add column if not exists checkout_mode        text check (checkout_mode in ('gated','live','sandbox','paddle')),
  add column if not exists paddle_price_id      text,
  add column if not exists paddle_product_ref   text,
  add column if not exists paddle_product_id    text,
  add column if not exists polar_product_id_sandbox text,
  add column if not exists polar_product_id_live    text,
  add column if not exists support_email        text,
  add column if not exists disclaimers          text[] not null default '{}',
  add column if not exists pdf_file             text,
  add column if not exists book_registry        text, -- repo-relative book identity file (e.g. books/duane.json); title SSOT
  add column if not exists working_note         text;

-- ---------------------------------------------------------------------------
-- product_rails: replaces data/settings/rails.<product>.json
-- (provider_router/MatrixRouter entries; one row per provider per product)
-- ---------------------------------------------------------------------------
create table public.product_rails (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products(id) on delete cascade,
  provider     text not null check (provider ~ '^[a-z0-9_-]{2,32}$'),
  weight       integer not null check (weight > 0),
  checkout_url text not null,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (product_id, provider)
);
create index if not exists product_rails_product_active_idx
  on public.product_rails (product_id) where active;

-- ---------------------------------------------------------------------------
-- creator_terms: revenue splits from data/settings/terms.json (Rule #0:
-- private). effective_from history is preserved — the split in force for a
-- sale is the latest row with effective_from <= sale time.
-- ---------------------------------------------------------------------------
create table public.creator_terms (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null references public.creators(id) on delete restrict,
  product_id       uuid not null references public.products(id) on delete restrict,
  effective_from   timestamptz not null,
  creator_split_pct numeric(5,2) not null check (creator_split_pct between 0 and 100),
  note             text,
  created_at       timestamptz not null default now(),
  unique (creator_id, product_id, effective_from)
);
create index if not exists creator_terms_lookup_idx
  on public.creator_terms (creator_id, product_id, effective_from desc);

-- ---------------------------------------------------------------------------
-- system_config: global commercial constraints from config.<creator>.json and
-- operator state (smoke flags, site origin, checkout notes). Key/value JSONB —
-- values are operator-managed, never client-writable.
-- ---------------------------------------------------------------------------
create table public.system_config (
  key        text primary key check (key ~ '^[a-z0-9_.-]{1,120}$'),
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Zero-trust RLS (explicitly executed per ADR-0060 discipline)
-- ---------------------------------------------------------------------------
alter table public.product_rails enable row level security;
alter table public.creator_terms enable row level security;
alter table public.system_config enable row level security;

-- product_rails: creators may read the rails of their OWN products; anon gets
-- no policy (deny-all); service_role bypasses RLS (checkout route + porting
-- script use the service client).
create policy product_rails_owner_read on public.product_rails
  for select to authenticated
  using (
    product_id in (
      select p.id from public.products p
      where p.creator_id in (select public.my_creator_ids())
    )
  );

-- creator_terms: NO policies — private financial data (Rule #0). RLS enabled
-- above denies anon and authenticated entirely; service_role bypasses.
-- system_config: NO policies — operator-owned global state; same deny-all
-- posture for non-service roles.
