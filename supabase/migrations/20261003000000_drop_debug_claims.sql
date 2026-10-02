-- Already applied live 2026-10-03 (apply_migration drop_debug_claims). Ad-hoc debug fn, never in a migration.
drop function if exists public.debug_claims();
