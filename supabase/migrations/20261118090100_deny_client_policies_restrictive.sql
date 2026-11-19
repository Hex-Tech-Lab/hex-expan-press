-- ROLLBACK (changes no data: it only changes the definitions of six policies, never a row).
-- Restores the PERMISSIVE policies that 20261027110501 created. Run as one transaction:
--   begin;
--   drop policy if exists deny_client_audit_launch_events on public.audit_launch_events;
--   create policy deny_client_audit_launch_events on public.audit_launch_events for all to anon, authenticated using (false) with check (false);
--   drop policy if exists deny_client_audit_log on public.audit_log;
--   create policy deny_client_audit_log on public.audit_log for all to anon, authenticated using (false) with check (false);
--   drop policy if exists deny_client_creator_terms on public.creator_terms;
--   create policy deny_client_creator_terms on public.creator_terms for all to anon, authenticated using (false) with check (false);
--   drop policy if exists deny_client_download_events on public.download_events;
--   create policy deny_client_download_events on public.download_events for all to anon, authenticated using (false) with check (false);
--   drop policy if exists deny_client_system_config on public.system_config;
--   create policy deny_client_system_config on public.system_config for all to anon, authenticated using (false) with check (false);
--   drop policy if exists deny_client_webhook_conflicts on public.webhook_conflicts;
--   create policy deny_client_webhook_conflicts on public.webhook_conflicts for all to anon, authenticated using (false) with check (false);
--   commit;
-- Note: "ALTER POLICY ... AS PERMISSIVE" is not valid PostgreSQL (ALTER POLICY has no AS clause; rejected with
-- a syntax error on PostgreSQL 18.3 / PGlite 0.5.8), so each policy is dropped and recreated instead.
--
-- Recreate the client deny policies as RESTRICTIVE (PR #136 review, P2).
--
-- Problem: 20261027110501 created `deny_client_*` as PERMISSIVE `using (false)`. Permissive policies are
-- combined with OR, so any later permissive client policy on these tables would silently grant access.
-- A RESTRICTIVE policy is combined with AND, so it denies whatever permissive policies exist.
--
-- Effect today: identical. Live check (2026-11-18, read-only): these six tables have no other policy,
-- so anon and authenticated are denied before and after. service_role bypasses RLS and is unchanged.
-- PostgreSQL cannot change a policy's permissive flag in place, so each policy is dropped and recreated.

do $$
declare t text;
begin
  foreach t in array array['audit_launch_events','audit_log','creator_terms','download_events','system_config','webhook_conflicts'] loop
    execute format('drop policy if exists %I on public.%I', 'deny_client_' || t, t);
    execute format('create policy %I on public.%I as restrictive for all to anon, authenticated using (false) with check (false)', 'deny_client_' || t, t);
  end loop;
end $$;
