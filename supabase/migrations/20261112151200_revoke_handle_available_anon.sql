-- Intentionally empty (Argon F-13). This version once ran: revoke execute on public.handle_available(text) from anon.
-- public.handle_available is defined only on feat/handle-availability (20261111090620 and later), not on this branch,
-- so the statement failed a clean replay. Production already recorded this version, and that run is unaffected: this
-- edit changes no live ACL. The anon revoke for the function is carried by 20261114120000_handle_available_revoke_public.sql
-- on feat/b2c-handles-backup-seed, guarded so it runs only where the function exists.
select 1;
