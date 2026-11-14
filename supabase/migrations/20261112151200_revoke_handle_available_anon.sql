-- Revoke anonymous EXECUTE on public.handle_available.
-- Guarded: the function is created by migrations on feat/handle-availability (not on this branch), so the revoke runs only when it exists.
-- The function returns only a boolean ("is this creator handle free?"). Logged-out callers (the anon role, using the
-- publishable key from the browser) no longer reach it directly. Signed-in and server callers are unaffected.
-- Nothing on main calls this function; the pending handle-availability route must call it server-side. See
-- web/app/api/handle-availability/route.ts on that branch.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'handle_available') then
    revoke execute on function public.handle_available(text) from anon;
  end if;
end $$;
