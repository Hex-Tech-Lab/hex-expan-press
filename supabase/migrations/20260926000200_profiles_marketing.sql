-- Buyer-side profiles + explicit marketing consents (portal step 1). Paris (eu-west-3).
-- Principles follow 20260926000000/…0100: RLS on every table; server-only writes;
-- helpers in the private schema; consents append-only via private.forbid_mutation().

create table public.profiles (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  email          text not null,
  full_name      text,
  avatar_url     text,
  auth_provider  text,                          -- as Supabase reports it; no CHECK: the signup trigger must never fail
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz,
  source         jsonb not null default '{}',   -- utm / dub click id
  role           text not null default 'buyer' check (role in ('buyer', 'creator', 'staff'))
);

create table public.marketing_consents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete restrict,  -- append-only evidence; erasure is a separate process
  email        text not null,
  decision     text not null check (decision in ('opt_in', 'opt_out')),
  source       text,
  text_version text not null,
  ip           inet,
  at           timestamptz not null default now()
);

-- Append-only enforcement for marketing_consents (reuse the portal helper).
create trigger marketing_consents_append_only before update or delete on public.marketing_consents
  for each row execute function private.forbid_mutation();

-- Profile bootstrap on signup. Security definer, empty search path (advisor style).
-- It never inserts a marketing consent: consent is explicit only.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, email, full_name, avatar_url, auth_provider)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url',
    new.raw_app_meta_data ->> 'provider'
  )
  on conflict (user_id) do nothing;
  return new;
exception when others then
  -- never block a sign-in because profile bootstrap failed; log and continue
  raise warning 'handle_new_user failed for %: %', new.id, sqlerrm;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

alter table public.profiles           enable row level security;
alter table public.marketing_consents enable row level security;

-- Read-only own-row policies; no client write policies (server writes only).
create policy profiles_read_own on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy marketing_consents_read_own on public.marketing_consents for select to authenticated
  using (user_id = (select auth.uid()));

create index on public.marketing_consents (user_id);
