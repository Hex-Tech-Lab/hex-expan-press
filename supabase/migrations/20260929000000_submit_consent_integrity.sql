-- Wave 6.3 consent integrity (P0): supersedes 20260927000100.
--  * C3_revenue_split is writable ONLY by service_role (the Firma e-sign webhook).
--    Authenticated creators could previously call this RPC directly (publishable
--    key + own JWT) and self-record the revenue-split consent, bypassing e-sign.
--  * A given C2_release_approval must carry a real SHA-256 of the approved release
--    PDF: 64 lowercase hex chars, never the all-zero placeholder.
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

  v_signer := coalesce(
    caller,
    p_user_id,
    (select cu.user_id from public.creator_users cu where cu.creator_id = v_creator limit 1),
    (select c.signed_by from public.consents c where c.product_id = p_product_id and c.kind = 'C1_data_accuracy' and c.decision = 'given' order by c.signed_at desc limit 1)
  );

  if v_signer is null then
    raise exception 'signed_by user cannot be determined';
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

  if length(trim(p_typed_name)) < 2 then
    raise exception 'typed name must be at least 2 characters';
  end if;

  -- Find previous consent of the same kind to set supersedes
  select id into v_supersedes
  from public.consents
  where product_id = p_product_id
    and kind = p_kind::public.consent_kind
  order by signed_at desc
  limit 1;

  insert into public.consents (
    kind, product_id, creator_id, decision, text_version,
    document_sha256, typed_name, signed_by, auth_provider, ip, user_agent,
    external_ref, evidence_path, supersedes
  )
  values (
    p_kind::public.consent_kind, p_product_id, v_creator, p_decision, p_text_version,
    p_document_sha256, p_typed_name,
    v_signer,
    p_auth_provider, p_ip, p_user_agent,
    p_external_ref, p_evidence_path, v_supersedes
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
