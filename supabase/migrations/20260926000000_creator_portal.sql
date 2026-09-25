-- Creator review & sign-off portal (ADR 0048). Paris (eu-west-3), project hex-expan-press.
-- Principles: RLS on every table; creators read only their own rows; all writes go through
-- server functions (service role). answers/consents/audit are append-only (no UPDATE/DELETE).

create extension if not exists pgcrypto;

create table public.creators (
  id            uuid primary key default gen_random_uuid(),
  handle        text not null unique check (handle ~ '^[a-z0-9_-]{2,64}$'),
  display_name  text not null,
  created_at    timestamptz not null default now()
);

-- Auth users linked to a creator (one creator may sign in with Google and email).
create table public.creator_users (
  creator_id  uuid not null references public.creators(id) on delete restrict,
  user_id     uuid not null references auth.users(id) on delete restrict,
  primary key (creator_id, user_id)
);

create table public.products (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null references public.creators(id) on delete restrict,
  slug             text not null check (slug ~ '^[a-z0-9-]{2,80}$'),
  title            text not null,
  release_label    text,
  release_sha256   text check (release_sha256 ~ '^[0-9a-f]{64}$'),
  release_path     text,             -- Storage object key of the review/release PDF
  created_at       timestamptz not null default now(),
  unique (creator_id, slug)
);

create type public.review_kind as enum ('contradiction', 'confirm', 'source', 'premise');
create type public.review_status as enum ('open', 'answered', 'applied', 'withdrawn');

create table public.review_items (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete restrict,
  code        text not null,                 -- e.g. A1, B3, C1 from the review queue
  kind        public.review_kind not null,
  question    text not null,
  options     jsonb not null default '[]',   -- [{key, label}]; free text always allowed
  anchor      jsonb,                         -- {chapter, page, quote} for the PDF highlight
  status      public.review_status not null default 'open',
  created_at  timestamptz not null default now(),
  unique (product_id, code)
);

create table public.review_answers (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references public.review_items(id) on delete restrict,
  choice       text,
  free_text    text,
  answered_by  uuid not null references auth.users(id) on delete restrict,
  answered_at  timestamptz not null default now(),
  check (choice is not null or free_text is not null)
);

create type public.consent_kind as enum ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split');

create table public.consents (
  id              uuid primary key default gen_random_uuid(),
  kind            public.consent_kind not null,
  product_id      uuid not null references public.products(id) on delete restrict,
  creator_id      uuid not null references public.creators(id) on delete restrict,
  decision        text not null check (decision in ('given', 'refused')),
  text_version    text not null,              -- version id of the consent wording shown
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  typed_name      text not null check (length(trim(typed_name)) >= 2),
  signed_by       uuid not null references auth.users(id) on delete restrict,
  auth_provider   text not null,
  ip              inet,
  user_agent      text,
  external_ref    text,                       -- Firma envelope id for C3
  evidence_path   text,                       -- Storage key of our copy of signed PDF/audit trail
  supersedes      uuid references public.consents(id),
  signed_at       timestamptz not null default now()
);

create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid references auth.users(id),
  creator_id  uuid references public.creators(id),
  event       text not null,
  details     jsonb not null default '{}'
);

-- Append-only enforcement: no UPDATE/DELETE on evidence tables, even for the service role.
create or replace function public.forbid_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create trigger review_answers_append_only before update or delete on public.review_answers
  for each row execute function public.forbid_mutation();
create trigger consents_append_only before update or delete on public.consents
  for each row execute function public.forbid_mutation();
create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function public.forbid_mutation();

-- Helper: creator ids the current user belongs to.
create or replace function public.my_creator_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select cu.creator_id from public.creator_users cu where cu.user_id = (select auth.uid())
$$;
revoke all on function public.my_creator_ids() from public, anon;
grant execute on function public.my_creator_ids() to authenticated;

alter table public.creators       enable row level security;
alter table public.creator_users  enable row level security;
alter table public.products       enable row level security;
alter table public.review_items   enable row level security;
alter table public.review_answers enable row level security;
alter table public.consents       enable row level security;
alter table public.audit_log      enable row level security;

-- Read-only policies for signed-in creators; no insert/update/delete policies (server writes only).
create policy creators_read on public.creators for select to authenticated
  using (id in (select public.my_creator_ids()));
create policy creator_users_read on public.creator_users for select to authenticated
  using (user_id = (select auth.uid()));
create policy products_read on public.products for select to authenticated
  using (creator_id in (select public.my_creator_ids()));
create policy review_items_read on public.review_items for select to authenticated
  using (product_id in (select p.id from public.products p where p.creator_id in (select public.my_creator_ids())));
create policy review_answers_read on public.review_answers for select to authenticated
  using (answered_by = (select auth.uid()));
create policy consents_read on public.consents for select to authenticated
  using (creator_id in (select public.my_creator_ids()));
-- audit_log: no client access at all (RLS on, no policy).

create index on public.products (creator_id);
create index on public.review_items (product_id);
create index on public.review_answers (item_id);
create index on public.review_answers (answered_by);
create index on public.consents (product_id, kind);
create index on public.consents (creator_id);
create index on public.consents (signed_by);
create index on public.consents (supersedes);
create index on public.creator_users (user_id);
create index on public.audit_log (creator_id);
create index on public.audit_log (actor);
