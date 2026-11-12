-- Revoke anonymous EXECUTE on public.handle_available.
-- The function returns only a boolean ("is this creator handle free?"). Logged-out callers (the anon role, using the
-- publishable key from the browser) no longer reach it directly. Signed-in and server callers are unaffected.
-- Nothing on main calls this function; the pending handle-availability route must call it server-side. See
-- web/app/api/handle-availability/route.ts on that branch.
revoke execute on function public.handle_available(text) from anon;
