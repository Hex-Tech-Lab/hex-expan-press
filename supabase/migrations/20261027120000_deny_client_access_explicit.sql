-- Explicit deny-all for client roles on server-only tables.
-- RLS already denies anon and authenticated when a table has no policy, so this changes no access.
-- It records the intent and clears the rls_enabled_no_policy INFO lint.
-- Server code reads and writes these tables through the service role (payments/src/supabase_admin.ts),
-- which bypasses RLS. Idempotent: drop-then-create, so a re-run is safe.
do $$
declare t text;
begin
  foreach t in array array['audit_launch_events','audit_log','creator_terms','download_events','system_config','webhook_conflicts'] loop
    execute format('drop policy if exists %I on public.%I', 'deny_client_' || t, t);
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', 'deny_client_' || t, t);
  end loop;
end $$;
