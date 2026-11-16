-- Consent supersession set (2026-11-16).
--
-- Problem: `supersedes` records ONE predecessor. If two heads exist for one
-- (creator, kind), a new row retires only the newest, so the chain never
-- resolves to a single head and the kind stays unsigned. submit_consent's
-- advisory lock stops new forks from forming; this makes the chain resolve
-- even when a fork exists.
--
-- Change:
--   * consents.supersedes_ids uuid[] records EVERY head the new row retires.
--   * consents.supersedes is kept, and set to the newest head (history and
--     older readers).
--   * No backfill. Existing rows get the column default '{}' (a metadata-only
--     change in PostgreSQL 11+); readers fall back to `supersedes` for them.
--   * The consents_append_only trigger is not touched. ADD COLUMN fires no
--     row triggers.
--   * submit_consent keeps its signature, grants, advisory lock and every
--     existing check. Only the head lookup and the insert changed.
--   * strict_active_consent_kinds and launch_block_reason (the SQL launch gate,
--     20261009000000) read supersedes_ids too. Without this the SQL gate would
--     block a launch that the TypeScript resolver allows, and the parity test
--     web/src/lib/__tests__/launch-gate-sql-parity.test.ts would fail.
--
-- Supersession rule (identical in SQL and web/src/lib/consent-chain.ts): a row
-- is superseded when a same-creator, same-kind row names it in `supersedes` OR
-- `supersedes_ids`. Cross-kind pointers never supersede.

alter table public.consents
  add column if not exists supersedes_ids uuid[] not null default '{}';

-- ---------------------------------------------------------------------------
-- SQL chain resolver (launch gate). Same contract as 20261009000000, with set
-- supersession.
-- ---------------------------------------------------------------------------
create or replace function public.strict_active_consent_kinds(p_creator_id uuid, p_product_id uuid)
returns setof text
language sql
stable
set search_path = public, pg_temp
as $$
  with chain as (
    select c.id, c.kind::text as kind, c.decision, c.product_id, c.supersedes, c.supersedes_ids
    from public.consents c
    where c.creator_id = p_creator_id
  ),
  superseded as (
    select target.id
    from chain succ
    join chain target
      on target.kind = succ.kind
     and (target.id = succ.supersedes or target.id = any (succ.supersedes_ids))
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

-- ---------------------------------------------------------------------------
-- Launch gate: the C2 hash check finds the C2 head with the same set-aware
-- supersession. Otherwise it is unchanged from 20261009000000.
-- ---------------------------------------------------------------------------
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
      where s.creator_id = p_creator_id
        and s.kind = c.kind
        and (s.supersedes = c.id or c.id = any (s.supersedes_ids))
    );

  if v_approved is distinct from v_release then
    return 'release hash mismatch: C2 approved a different release';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_consent: same signature, grants, checks and advisory lock as
-- 20261004000900_submit_consent_race_lock.sql. Changed: the head lookup now
-- collects every current head of (product, kind) into supersedes_ids.
-- ---------------------------------------------------------------------------
create or replace function public.submit_consent(
  p_product_id uuid,
  p_kind text,
  p_decision text,
  p_text_version text,
  p_document_sha256 text,
  p_typed_name text,
  p_ip inet,
  p_user_agent text,
  p_auth_provider text,
  p_external_ref text default null,
  p_evidence_path text default null,
  p_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller      uuid := (select auth.uid());
  is_service  boolean := (auth.role() = 'service_role' or current_user = 'service_role');
  v_creator   uuid;
  v_consent   uuid;
  v_supersedes uuid;
  v_heads     uuid[] := '{}';
  v_signer    uuid;
  v_release   text;
  v_auth_provider text := p_auth_provider;
  v_external_ref  text := p_external_ref;
  v_evidence_path text := p_evidence_path;
begin
  if caller is null and not is_service then
    raise exception 'not authenticated';
  end if;

  if is_service then
    -- service_role (backend webhook/system): resolve creator directly from the product
    select p.creator_id into v_creator
    from public.products p
    where p.id = p_product_id;
  else
    -- Verify product belongs to caller's creators
    select p.creator_id into v_creator
    from public.products p
    where p.id = p_product_id
      and p.creator_id in (select private.my_creator_ids());
  end if;

  if v_creator is null then
    raise exception 'product not found or not authorized';
  end if;

  -- Signer identity is never guessed (sharp-edges audit 2026-10-01): an end user
  -- always signs as themselves (p_user_id is ignored); the service role must name
  -- the signer explicitly, and that user must belong to the product's creator.
  if is_service then
    if p_user_id is null then
      raise exception 'service-role consent requires p_user_id';
    end if;
    if not exists (
      select 1 from public.creator_users cu
      where cu.creator_id = v_creator and cu.user_id = p_user_id
    ) then
      raise exception 'p_user_id is not a member of the product''s creator';
    end if;
    v_signer := p_user_id;
  else
    v_signer := caller;
  end if;

  if p_kind not in ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split') then
    raise exception 'invalid consent kind';
  end if;

  if p_decision not in ('given', 'refused') then
    raise exception 'invalid decision';
  end if;

  if p_kind = 'C3_revenue_split' and not is_service then
    raise exception 'C3_revenue_split can only be recorded by the e-sign webhook';
  end if;

  if p_kind = 'C2_release_approval' and p_decision = 'given' and (
       p_document_sha256 is null
       or p_document_sha256 !~ '^[0-9a-f]{64}$'
       or p_document_sha256 = repeat('0', 64)
     ) then
    raise exception 'C2_release_approval requires the release PDF sha256';
  end if;

  -- F2: a C2 approval must be for the release actually on file, not any hash.
  if p_kind = 'C2_release_approval' and p_decision = 'given' then
    select lower(p.release_sha256) into v_release
    from public.products p
    where p.id = p_product_id;
    if v_release is null or v_release <> p_document_sha256 then
      raise exception 'C2_release_approval sha256 does not match the product release';
    end if;
  end if;

  -- F2: end users cannot assert provenance — auth provider comes from their JWT,
  -- and external_ref / evidence_path are reserved for the service role.
  if not is_service then
    v_auth_provider := coalesce((select auth.jwt()) -> 'app_metadata' ->> 'provider', 'unknown');
    v_external_ref  := null;
    v_evidence_path := null;
  end if;

  -- evidence_path contract: must be <signer-user-uuid>/<envelope-id>.pdf and the
  -- user segment must match the resolved signer.
  if v_evidence_path is not null then
    if v_evidence_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{1,128}\.pdf$' then
      raise exception 'evidence_path must be <user-uuid>/<envelope-id>.pdf';
    end if;
    if split_part(v_evidence_path, '/', 1)::uuid <> v_signer then
      raise exception 'evidence_path user does not match the signer';
    end if;
    -- The envelope segment must name the same envelope as external_ref (the F5 replay key).
    if v_external_ref is null or split_part(v_evidence_path, '/', 2) <> v_external_ref || '.pdf' then
      raise exception 'evidence_path envelope does not match external_ref';
    end if;
  end if;

  if length(trim(p_typed_name)) < 2 then
    raise exception 'typed name must be at least 2 characters';
  end if;

  -- F6 (sprint10): serialize concurrent submits for the same (product, kind) so two
  -- transactions can never both read the same prior heads and insert two live heads.
  perform pg_advisory_xact_lock(hashtextextended(p_product_id::text || ':' || p_kind, 0));

  -- Current heads of this (product, kind), with supersession resolved creator-wide
  -- exactly as the readers resolve it: a row is retired when a same-creator,
  -- same-kind row names it in supersedes or supersedes_ids. The new row retires
  -- EVERY head (supersedes_ids); `supersedes` keeps the newest head for history.
  -- id DESC tie-breaker: two rows can share signed_at (same-millisecond inserts);
  -- without the tie-break the order is nondeterministic across replays.
  v_heads := array(
    select c.id
    from public.consents c
    where c.creator_id = v_creator
      and c.product_id = p_product_id
      and c.kind = p_kind::public.consent_kind
      and not exists (
        select 1 from public.consents s
        where s.creator_id = v_creator
          and s.kind = c.kind
          and (s.supersedes = c.id or c.id = any (s.supersedes_ids))
      )
    order by c.signed_at desc, c.id desc
  );
  v_supersedes := v_heads[1];

  -- clock_timestamp(), not the column default now(): now() is transaction-start
  -- time, so a transaction that waited on the advisory lock would otherwise carry
  -- a signed_at OLDER than the head it supersedes — breaking the signed_at-desc
  -- head ordering the launch gate (payments/src/launch_gate.ts) and this RPC both rely on.
  insert into public.consents (
    kind, product_id, creator_id, decision, text_version,
    document_sha256, typed_name, signed_at, signed_by, auth_provider, ip, user_agent,
    external_ref, evidence_path, supersedes, supersedes_ids
  )
  values (
    p_kind::public.consent_kind, p_product_id, v_creator, p_decision, p_text_version,
    p_document_sha256, p_typed_name,
    clock_timestamp(),
    v_signer,
    v_auth_provider, p_ip, p_user_agent,
    v_external_ref, v_evidence_path, v_supersedes, v_heads
  )
  returning id into v_consent;

  -- `at` stamped with clock_timestamp() explicitly: the column default is
  -- now() (transaction START), and this transaction waited on the advisory
  -- lock — an audit entry timestamped before the record it describes would
  -- be indistinguishable from an ordering bug (external review PR #78).
  insert into public.audit_log (actor, creator_id, event, details, at)
  values (v_signer, v_creator, 'consent_submitted',
          jsonb_build_object('consent_id', v_consent, 'kind', p_kind, 'decision', p_decision,
                             'via_service_role', is_service),
          clock_timestamp());

  return v_consent;
end $$;

revoke all on function public.submit_consent(uuid, text, text, text, text, text, inet, text, text, text, text, uuid) from public, anon;
grant execute on function public.submit_consent(uuid, text, text, text, text, text, inet, text, text, text, text, uuid) to authenticated, service_role;
