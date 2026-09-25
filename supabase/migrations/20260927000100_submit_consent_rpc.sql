-- Portal step 3: consents via RPC.
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
  p_evidence_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller    uuid := (select auth.uid());
  v_creator uuid;
  v_consent uuid;
  v_supersedes uuid;
begin
  if caller is null then
    raise exception 'not authenticated';
  end if;

  -- Verify product belongs to caller's creators
  select p.creator_id into v_creator
  from public.products p
  where p.id = p_product_id
    and p.creator_id in (select private.my_creator_ids());

  if v_creator is null then
    raise exception 'product not found or not authorized';
  end if;

  if p_kind not in ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split') then
    raise exception 'invalid consent kind';
  end if;
  
  if p_decision not in ('given', 'refused') then
    raise exception 'invalid decision';
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
    p_document_sha256, p_typed_name, caller, p_auth_provider, p_ip, p_user_agent,
    p_external_ref, p_evidence_path, v_supersedes
  )
  returning id into v_consent;

  insert into public.audit_log (actor, creator_id, event, details)
  values (caller, v_creator, 'consent_submitted',
          jsonb_build_object('consent_id', v_consent, 'kind', p_kind, 'decision', p_decision));

  return v_consent;
end $$;

revoke all on function public.submit_consent(uuid, text, text, text, text, text, inet, text, text, text, text) from public, anon;
grant execute on function public.submit_consent(uuid, text, text, text, text, text, inet, text, text, text, text) to authenticated;
