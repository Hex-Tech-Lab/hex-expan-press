-- Public handle availability check. Returns only true or false, so anonymous callers learn one bit.
-- creators is not readable anonymously (RLS), so the check runs as the function owner.
-- Anonymous callers get EXECUTE on this function only, never on the table.

create or replace function public.handle_available(p_handle text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.creators c where c.handle = lower(p_handle)
  );
$$;

revoke execute on function public.handle_available(text) from public;
grant execute on function public.handle_available(text) to anon, authenticated;
