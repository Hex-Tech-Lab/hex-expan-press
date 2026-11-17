-- Reconciled 2026-11-17 from production supabase_migrations.schema_migrations (version 20261027110501); SQL as applied.
do $$
declare t text;
begin
  foreach t in array array['audit_launch_events','audit_log','creator_terms','download_events','system_config','webhook_conflicts'] loop
    execute format('drop policy if exists %I on public.%I', 'deny_client_' || t, t);
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', 'deny_client_' || t, t);
  end loop;
end $$;
