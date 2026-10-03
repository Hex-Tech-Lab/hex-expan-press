-- E2E contract probe for submit_consent's p_evidence_path (migration 20261004000200).
-- Runs every case as the service role inside ONE transaction that always aborts
-- (final RAISE), so nothing persists, including in the append-only consents table.
-- Run against a project where :product belongs to a creator that :user is a member of.
-- Expected: every path REJECTED except '<signer-uuid>/<envelope-id>.pdf' with a matching
-- external_ref; the envelope/external_ref mismatch case is REJECTED too.
-- Verified on production 2026-10-03 with the founder's test copy (product cd9ec10d…).
do $$
declare
  v_product uuid := (select id from public.products where id::text like 'cd9ec10d%');
  v_user    uuid := '31b87bf4-71a1-40f1-9257-44c22f2a3814';
  results   text := '';
  p         text;
  paths     text[] := array[
    '../../etc/passwd.pdf',                                      -- traversal / wrong shape
    'legal-docs/revenue_split_agreement_v0.4.pdf',               -- bucket-style path
    '00000000-0000-0000-0000-000000000000/env_x.pdf',            -- another user's id
    '31B87BF4-71A1-40F1-9257-44C22F2A3814/env_x.pdf',            -- non-canonical uuid
    '31b87bf4-71a1-40f1-9257-44c22f2a3814/env_x.pdf.exe',        -- wrong extension
    '31b87bf4-71a1-40f1-9257-44c22f2a3814/env_e2e_probe.pdf'];   -- valid -> ACCEPTED
  -- external_ref is the path's own envelope id, so only the shape/signer rules decide;
  -- the mismatch case is exercised separately below.
begin
  -- Fixture guard: without these every call fails early and the valid case reads as REJECTED.
  if v_product is null then
    raise exception 'probe product cd9ec10d… not found';
  end if;
  if not exists (select 1 from public.creator_users cu join public.products pr on pr.creator_id = cu.creator_id
                 where pr.id = v_product and cu.user_id = v_user) then
    raise exception 'probe user is not a member of the probe product''s creator';
  end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  foreach p in array paths loop
    begin
      perform public.submit_consent(v_product, 'C3_revenue_split', 'given', 'v1.1',
        repeat('a', 64), 'Signed via firma', '127.0.0.1'::inet, 'e2e-probe', 'firma',
        coalesce(substring(p from '/([A-Za-z0-9_-]+)\.pdf$'), 'env_x'), p, v_user);
      results := results || ' | ACCEPTED ' || p;
    exception when others then
      results := results || ' | REJECTED ' || p || ' (' || sqlerrm || ')';
    end;
  end loop;
  begin -- envelope segment vs external_ref mismatch
    perform public.submit_consent(v_product, 'C3_revenue_split', 'given', 'v1.1',
      repeat('a', 64), 'Signed via firma', '127.0.0.1'::inet, 'e2e-probe', 'firma',
      'env_other', '31b87bf4-71a1-40f1-9257-44c22f2a3814/env_e2e_probe.pdf', v_user);
    results := results || ' | ACCEPTED envelope/external_ref mismatch';
  exception when others then
    results := results || ' | REJECTED envelope/external_ref mismatch (' || sqlerrm || ')';
  end;
  raise exception 'E2E-ROLLBACK%', results; -- always abort: nothing is committed
end $$;
