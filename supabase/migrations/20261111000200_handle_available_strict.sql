-- Makes handle_available strict: a NULL argument returns NULL, not true (review finding: a direct RPC call
-- with NULL was reported as "free"). Replaces the function from 20261111000100 with the same body.
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
