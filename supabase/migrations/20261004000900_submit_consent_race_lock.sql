-- F6 (P2, sprint10 audit): consent supersession race.
-- Identical to 20261004000300 except the advisory xact lock serializing
-- concurrent submit_consent calls for the same (product_id, kind).
-- Contract consolidation P2 (review follow-up): tie submit_consent's evidence_path
-- envelope segment to external_ref, so evidence and the F5 replay key always name
-- the same Firma envelope. Body otherwise identical to 20261004000200.

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
  -- transactions can never both read the same prior head and insert two live heads.
  perform pg_advisory_xact_lock(hashtextextended(p_product_id::text || ':' || p_kind, 0));
  -- Find previous consent of the same kind to set supersedes
  select id into v_supersedes
  from public.consents
  where product_id = p_product_id
    and kind = p_kind::public.consent_kind
  order by signed_at desc
  limit 1;

  -- clock_timestamp(), not the column default now(): now() is transaction-start
  -- time, so a transaction that waited on the advisory lock would otherwise carry
  -- a signed_at OLDER than the head it supersedes — breaking the signed_at-desc
  -- head ordering the bake lookup and this RPC both rely on.
  insert into public.consents (
    kind, product_id, creator_id, decision, text_version,
    document_sha256, typed_name, signed_at, signed_by, auth_provider, ip, user_agent,
    external_ref, evidence_path, supersedes
  )
  values (
    p_kind::public.consent_kind, p_product_id, v_creator, p_decision, p_text_version,
    p_document_sha256, p_typed_name,
    clock_timestamp(),
    v_signer,
    v_auth_provider, p_ip, p_user_agent,
    v_external_ref, v_evidence_path, v_supersedes
  )
  returning id into v_consent;

  insert into public.audit_log (actor, creator_id, event, details)
  values (v_signer, v_creator, 'consent_submitted',
          jsonb_build_object('consent_id', v_consent, 'kind', p_kind, 'decision', p_decision,
                             'via_service_role', is_service));

  return v_consent;
end $$;


revoke all on function public.submit_consent(uuid, text, text, text, text, text, inet, text, text, text, text, uuid) from public, anon;
grant execute on function public.submit_consent(uuid, text, text, text, text, text, inet, text, text, text, text, uuid) to authenticated, service_role;
