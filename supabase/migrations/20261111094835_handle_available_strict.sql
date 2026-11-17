-- Reconciled 2026-11-17 from production supabase_migrations.schema_migrations (version 20261111094835); SQL as applied.
create or replace function public.handle_available(p_handle text)
returns boolean
language sql
stable
strict
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.creators c where c.handle = lower(p_handle)
  );
$$;
