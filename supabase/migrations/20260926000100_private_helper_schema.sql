-- Move helper functions out of the exposed API schema (advisor 0029: security definer callable via RPC).
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
alter function public.my_creator_ids() set schema private;
alter function public.forbid_mutation() set schema private;
