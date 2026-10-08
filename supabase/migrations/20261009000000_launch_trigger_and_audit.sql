-- Sprint 17 Phase 2: zero-trust launch gate.
--
-- A product may only transition to checkout_mode = 'live' when its consent
-- chain verifies AND the C2 head approved the product's current release PDF.
-- Enforced by a BEFORE INSERT/UPDATE trigger, so it holds for every writer —
-- service role, SQL editor and migrations included (RLS cannot stop those).
-- Each verified launch is recorded in public.audit_launch_events.
--
-- Chain semantics mirror strictActiveConsentKinds (web/src/lib/consent-chain.ts):
--   * supersession is resolved CREATOR-WIDE: a row is superseded when another
--     row of the SAME kind points at it via supersedes (cross-kind pointers
--     never supersede);
--   * heads are then scoped to the product;
--   * a kind is active only with EXACTLY ONE head whose decision is 'given'.
-- web/src/lib/__tests__/launch-gate-sql-parity.test.ts runs both resolvers
-- over the same fixtures.

create or replace function public.strict_active_consent_kinds(p_creator_id uuid, p_product_id uuid)
returns setof text
language sql
stable
set search_path = public, pg_temp
as $$
  with chain as (
    select c.id, c.kind::text as kind, c.decision, c.product_id, c.supersedes
    from public.consents c
    where c.creator_id = p_creator_id
  ),
  superseded as (
    select succ.supersedes as id
    from chain succ
    join chain target on target.id = succ.supersedes and target.kind = succ.kind
  ),
  heads as (
    select ch.* from chain ch
    where ch.product_id = p_product_id
      and ch.id not in (select id from superseded)
  )
  select kind from heads
  group by kind
  having count(*) = 1 and bool_and(decision = 'given');
$$;

-- Returns NULL when the product may launch, else the blocking reason.
create or replace function public.launch_block_reason(p_product_id uuid, p_creator_id uuid, p_release_sha256 text)
returns text
language plpgsql
volatile -- each statement takes a fresh snapshot, so rows committed while the
         -- caller waited on the consent locks are seen
set search_path = public, pg_temp
as $$
declare
  v_release text := lower(btrim(coalesce(p_release_sha256, '')));
  v_approved text;
  v_active text[];
begin
  if p_creator_id is null then
    return 'product has no owner';
  end if;
  if v_release !~ '^[0-9a-f]{64}$' or v_release = repeat('0', 64) then
    return 'product has no valid release_sha256';
  end if;

  select array_agg(k) into v_active from public.strict_active_consent_kinds(p_creator_id, p_product_id) k;
  if v_active is null
     or not (v_active @> array['C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split']) then
    return 'required consents (C1/C2/C3) are not all active';
  end if;

  -- C2 is active, so it has exactly one product-scoped head.
  select lower(btrim(coalesce(c.document_sha256, ''))) into v_approved
  from public.consents c
  where c.creator_id = p_creator_id
    and c.product_id = p_product_id
    and c.kind = 'C2_release_approval'
    and not exists (
      select 1 from public.consents s
      where s.creator_id = p_creator_id and s.supersedes = c.id and s.kind = c.kind
    );

  if v_approved is distinct from v_release then
    return 'release hash mismatch: C2 approved a different release';
  end if;
  return null;
end;
$$;

create table if not exists public.audit_launch_events (
  id             bigint generated always as identity primary key,
  product_id     uuid not null references public.products(id),
  release_sha256 text not null,
  launched_at    timestamptz not null default now(),
  launched_by    text not null
);
alter table public.audit_launch_events enable row level security;
-- No policies, and no direct writes for API roles (service_role included):
-- rows are written only by the SECURITY DEFINER launch trigger.
revoke all on public.audit_launch_events from public, anon, authenticated, service_role;
grant select on public.audit_launch_events to service_role;

-- Append-only: history can never be rewritten or erased through DML.
create or replace function public.audit_launch_events_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'audit_launch_events is append-only (% blocked)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;
drop trigger if exists audit_launch_events_append_only on public.audit_launch_events;
create trigger audit_launch_events_append_only
  before update or delete on public.audit_launch_events
  for each row execute function public.audit_launch_events_append_only();
drop trigger if exists audit_launch_events_no_truncate on public.audit_launch_events;
create trigger audit_launch_events_no_truncate
  before truncate on public.audit_launch_events
  for each statement execute function public.audit_launch_events_append_only();

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
  -- INSERT ... 'live' is gated too (OLD is unset on insert).
  if new.checkout_mode = 'live' and (tg_op = 'INSERT' or old.checkout_mode is distinct from 'live') then
    -- Serialize with submit_consent (same per-(product, kind) advisory lock,
    -- 20261004000900): a refusal cannot commit between this check and the
    -- launch. Fixed kind order; submit_consent takes one lock, so no cycle.
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
    insert into public.audit_launch_events (product_id, release_sha256, launched_by)
    values (
      new.id,
      lower(btrim(new.release_sha256)),
      coalesce(nullif(current_setting('role', true), 'none'), session_user::text) || ' (session ' || session_user::text || ')'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists products_launch_gate on public.products;
create trigger products_launch_gate
  before insert or update of checkout_mode on public.products
  for each row execute function public.enforce_launch_gate();

revoke all on function public.enforce_launch_gate() from public, anon, authenticated;
revoke all on function public.launch_block_reason(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.strict_active_consent_kinds(uuid, uuid) from public, anon, authenticated;
