-- C3 evidence contract probe (migrations 20261004000400 + 20261004000700). NOT YET EXECUTED: authored in a
-- sandbox with no Postgres; K runs it in the SQL editor against a project where :product belongs to a creator
-- that :user is a member of (same fixture as submit_consent_evidence_path.sql).
-- Every case runs as the service role inside ONE transaction that always aborts (final RAISE), so nothing persists.
-- Output: 'C3-EVIDENCE PASS' or 'C3-EVIDENCE FAIL <n>' plus one line per case (OK/UNEXPECTED).
do $$
declare
  v_product  uuid := (select id from public.products where id::text like 'cd9ec10d%');
  v_user     uuid := '31b87bf4-71a1-40f1-9257-44c22f2a3814';
  v_creator  uuid;
  v_ok       boolean;
  v_err      text;
  v_fail     int := 0;
  v_report   text := '';
  c          record;
  v_hash     text := repeat('a', 64);
begin
  if v_product is null then raise exception 'probe product cd9ec10d… not found'; end if;
  select creator_id into v_creator from public.products where id = v_product;
  if not exists (select 1 from public.creator_users where creator_id = v_creator and user_id = v_user) then
    raise exception 'probe user is not a member of the probe product''s creator';
  end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- A. RPC cases: (label, decision, external_ref, evidence_path, expect_ok)
  for c in select * from (values
    ('rpc C3 given, evidence NULL',                'given',   'env_c3_a', null::text,                                                    false),
    ('rpc C3 given, valid evidence',               'given',   'env_c3_b', v_user::text || '/env_c3_b.pdf',                               true),
    ('rpc C3 given, evidence for another user',    'given',   'env_c3_c', '00000000-0000-0000-0000-000000000000/env_c3_c.pdf',           false),
    ('rpc C3 given, envelope != external_ref',     'given',   'env_c3_d', v_user::text || '/env_other.pdf',                              false),
    ('rpc C3 refused, evidence NULL',              'refused', 'env_c3_e', null::text,                                                    true)
  ) as t(label, decision, ext, path, expect_ok) loop
    begin
      perform public.submit_consent(v_product, 'C3_revenue_split', c.decision, 'v1.1', v_hash, 'Signed via firma',
        '127.0.0.1'::inet, 'c3-evidence-probe', 'firma', c.ext, c.path, v_user);
      v_ok := true; v_err := null;
    exception when others then v_ok := false; v_err := sqlerrm; end;
    if v_ok <> c.expect_ok then v_fail := v_fail + 1; end if;
    v_report := v_report || E'\n' || case when v_ok = c.expect_ok then 'OK         ' else 'UNEXPECTED ' end
                || c.label || ' -> ' || case when v_ok then 'ACCEPTED' else 'REJECTED (' || v_err || ')' end;
  end loop;

  -- B. Direct table inserts (service role bypasses the RPC): (label, kind, decision, external_ref, evidence_path, expect_ok)
  for c in select * from (values
    ('table C3 given, evidence NULL',             'C3_revenue_split', 'given',   'env_t_a', null::text,                                  false),
    ('table C3 given, malformed path',            'C3_revenue_split', 'given',   'env_t_b', '../../etc/passwd.pdf',                      false),
    ('table C3 given, path user != signed_by',    'C3_revenue_split', 'given',   'env_t_c', '00000000-0000-0000-0000-000000000000/env_t_c.pdf', false),
    ('table C3 given, envelope != external_ref',  'C3_revenue_split', 'given',   'env_t_d', v_user::text || '/env_other.pdf',            false),
    ('table C3 given, valid evidence',            'C3_revenue_split', 'given',   'env_t_e', v_user::text || '/env_t_e.pdf',              true),
    ('table C3 refused, evidence NULL',           'C3_revenue_split', 'refused', 'env_t_f', null::text,                                  true),
    ('table C1 given, evidence NULL (scope)',     'C1_data_accuracy', 'given',   null::text, null::text,                                 true)
  ) as t(label, kind, decision, ext, path, expect_ok) loop
    begin
      insert into public.consents (kind, product_id, creator_id, decision, text_version, document_sha256, typed_name,
                                   signed_by, auth_provider, external_ref, evidence_path)
      values (c.kind::public.consent_kind, v_product, v_creator, c.decision, 'v1.1', v_hash, 'Signed via firma',
              v_user, 'firma', c.ext, c.path);
      v_ok := true; v_err := null;
    exception when others then v_ok := false; v_err := sqlerrm; end;
    if v_ok <> c.expect_ok then v_fail := v_fail + 1; end if;
    v_report := v_report || E'\n' || case when v_ok = c.expect_ok then 'OK         ' else 'UNEXPECTED ' end
                || c.label || ' -> ' || case when v_ok then 'ACCEPTED' else 'REJECTED (' || v_err || ')' end;
  end loop;

  raise exception 'E2E-ROLLBACK C3-EVIDENCE % %', case when v_fail = 0 then 'PASS' else 'FAIL ' || v_fail end, v_report;
end $$;
