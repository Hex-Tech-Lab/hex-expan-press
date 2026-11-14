-- Hardening: revoke EXECUTE from PUBLIC as well as anon. PostgreSQL grants EXECUTE to PUBLIC by default,
-- so revoking from anon alone is not enough when the schema is rebuilt from migrations.
-- Live ACL checked read-only on 2026-11-14 (hex-expan-test and production): no PUBLIC entry, anon cannot execute,
-- authenticated/service_role/postgres keep EXECUTE. This file matches that live state. Not applied to production yet.
revoke all on function public.handle_available(text) from public, anon;
grant execute on function public.handle_available(text) to authenticated, service_role;
