-- Hardens public.handle_available (approved 2026-11-11). Intentional SECURITY DEFINER boolean check, so it stays
-- definer; search_path is pinned empty and every name is schema-qualified, which closes the search-path hijack class.
-- This does NOT address Supabase lint 0028/0029: those flag anon and authenticated EXECUTE on a SECURITY DEFINER
-- function, and the grants below are unchanged. Those lints stay open until the founder decides the exposure.
-- Body logic unchanged. create or replace keeps the existing grants (anon, authenticated) and the revoke from public.
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
