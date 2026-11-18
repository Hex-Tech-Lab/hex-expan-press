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
