-- Hardens public.handle_available (approved 2026-11-11). Intentional SECURITY DEFINER boolean check, so it stays
-- definer; search_path is pinned empty and every name is schema-qualified, closing the search-path hijack class
-- that the Supabase lint 0028/0029 asks to be acknowledged or fixed. Body logic unchanged. create or replace keeps
-- the existing grants (anon, authenticated) and the revoke from public.
create or replace function public.handle_available(p_handle text)
returns boolean
language sql
stable
strict
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from public.creators c where c.handle = pg_catalog.lower(p_handle)
  );
$$;
