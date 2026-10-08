-- Sprint 19 zero-trust fix (AGY red-team finding 1, 2026-10-09): the launch
-- gate fired only on checkout_mode changes, so a LIVE product's release_sha256
-- (or creator_id, which selects the consent chain) could be changed with no
-- database-level check — only the checkout route's per-request hash check
-- caught it. The gate now re-verifies whenever a live product's release hash
-- or owner changes, and records the re-verified release in audit_launch_events.

create or replace function public.enforce_launch_gate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text;
  v_kind text;
begin
  -- Gate: going live (INSERT ... 'live' included; OLD is unset on insert), or
  -- staying live while the release hash or the owning creator changes.
  if new.checkout_mode = 'live' and (
       tg_op = 'INSERT'
       or old.checkout_mode is distinct from 'live'
       or old.release_sha256 is distinct from new.release_sha256
       or old.creator_id is distinct from new.creator_id
     ) then
    -- Serialize with submit_consent (same per-(product, kind) advisory lock,
    -- 20261004000900): a refusal cannot commit between this check and the
    -- write. Fixed kind order; submit_consent takes one lock, so no cycle.
    foreach v_kind in array array['C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split'] loop
      perform pg_advisory_xact_lock(hashtextextended(new.id::text || ':' || v_kind, 0));
    end loop;
    v_reason := public.launch_block_reason(new.id, new.creator_id, new.release_sha256);
    if v_reason is not null then
      raise exception 'launch blocked for product %: %', new.id, v_reason
        using errcode = 'check_violation';
    end if;
    -- Actor: inside SECURITY DEFINER current_user is the function owner, so
    -- record the effective session role (e.g. service_role under PostgREST)
    -- and the login role.
    insert into public.audit_launch_events (product_id, release_sha256, launched_at, launched_by)
    values (
      new.id,
      lower(btrim(new.release_sha256)),
      clock_timestamp(), -- after the lock wait, not transaction start
      coalesce(nullif(current_setting('role', true), 'none'), session_user::text) || ' (session ' || session_user::text || ')'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists products_launch_gate on public.products;
create trigger products_launch_gate
  before insert or update of checkout_mode, release_sha256, creator_id on public.products
  for each row execute function public.enforce_launch_gate();

revoke all on function public.enforce_launch_gate() from public, anon, authenticated;
