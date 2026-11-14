-- Hardening: revoke EXECUTE from PUBLIC as well as anon. PostgreSQL grants EXECUTE to PUBLIC by default,
-- so revoking from anon alone is not enough when the schema is rebuilt from migrations.
-- Live ACL checked read-only on 2026-11-14 (hex-expan-test and production): no PUBLIC entry, anon cannot execute,
-- authenticated/service_role/postgres keep EXECUTE. This file matches that live state. Not applied to production yet.
-- Guarded: runs only when the function exists (created on feat/handle-availability, not on this branch).
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'handle_available') then
    revoke all on function public.handle_available(text) from public, anon;
    grant execute on function public.handle_available(text) to authenticated, service_role;
  end if;
end $$;
