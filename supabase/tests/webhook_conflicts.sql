-- Rollback-only probe for 20261004000800_webhook_conflicts.sql. NOT executed in CI: run in the Supabase SQL editor
-- AFTER applying the migration. It writes fixture rows and ALWAYS ends in an exception, so nothing persists.
-- Pass: the final message is "E2E-ROLLBACK WEBHOOK-CONFLICTS PASS 9/9". Any "FAIL n" line names the broken case.
do $$
declare
  v_id1 bigint;
  v_id2 bigint;
  v_id3 bigint;
  v_count integer;
  v_audit integer;
  v_pass integer := 0;
  v_fail text := '';
  v_sha1 text := repeat('a', 64);
  v_sha2 text := repeat('b', 64);
  v_flag jsonb := jsonb_build_object(
    'reason', 'adjustment_id_collision', 'provider', 'probe', 'sale_id', 'probe_sale', 'refund_id', null,
    'refund_cents', 3900, 'sale_cents', 3900, 'creator_id', null, 'occurred_at', '2026-10-04T00:00:00.000Z',
    'adjustment_id', 'probe_adj', 'event_type', 'refund', 'incoming_currency', 'USD',
    'conflicting_sale_id', 'probe_other', 'conflicting_cents', 1250, 'conflicting_currency', 'EUR');
  v_incoming jsonb := jsonb_build_object('sale_id', 'probe_sale', 'adjustment_id', 'probe_adj');
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;

  -- 1: first call inserts a pending row and returns its id
  v_id1 := public.record_webhook_conflict('probe', 'refund', 'probe_sale', 'probe_adj', v_incoming, v_sha1, 'probe_other', 1250, 'EUR', v_flag);
  if v_id1 is not null then v_pass := v_pass + 1; else v_fail := v_fail || ' FAIL 1'; end if;

  -- 2: identical redelivery dedupes: same id, delivery_count 2
  v_id2 := public.record_webhook_conflict('probe', 'refund', 'probe_sale', 'probe_adj', v_incoming, v_sha1, 'probe_other', 1250, 'EUR', v_flag);
  reset role;
  select delivery_count into v_count from public.webhook_conflicts where id = v_id1;
  if v_id2 = v_id1 and v_count = 2 then v_pass := v_pass + 1; else v_fail := v_fail || ' FAIL 2'; end if;

  -- 3: exactly one audit_log flag despite two deliveries
  select count(*) into v_audit from public.audit_log
   where event = 'MANUAL_REVIEW_REQUIRED_REFUND' and details->>'adjustment_id' = 'probe_adj' and details->>'provider' = 'probe';
  if v_audit = 1 then v_pass := v_pass + 1; else v_fail := v_fail || ' FAIL 3'; end if;

  -- 4: a different payload hash under the same adjustment id is a second row
  set local role service_role;
  v_id3 := public.record_webhook_conflict('probe', 'refund', 'probe_sale', 'probe_adj', v_incoming, v_sha2, 'probe_other', 1250, 'EUR', v_flag);
  reset role;
  if v_id3 is not null and v_id3 <> v_id1 then v_pass := v_pass + 1; else v_fail := v_fail || ' FAIL 4'; end if;

  -- 5: the RPC refuses a non-service caller
  begin
    perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
    perform public.record_webhook_conflict('probe', 'refund', 'x', 'x', v_incoming, v_sha1, 'y', 1, 'USD', v_flag);
    v_fail := v_fail || ' FAIL 5';
  exception when others then
    if sqlerrm like '%service-role only%' then v_pass := v_pass + 1; else v_fail := v_fail || ' FAIL 5(' || sqlerrm || ')'; end if;
  end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 6: immutable columns cannot change
  begin
    update public.webhook_conflicts set sale_id = 'tampered' where id = v_id1;
    v_fail := v_fail || ' FAIL 6';
  exception when others then
    if sqlerrm like '%only counters and resolution fields are mutable%' then v_pass := v_pass + 1; else v_fail := v_fail || ' FAIL 6(' || sqlerrm || ')'; end if;
  end;

  -- 7: deletes are forbidden
  begin
    delete from public.webhook_conflicts where id = v_id1;
    v_fail := v_fail || ' FAIL 7';
  exception when others then
    if sqlerrm like '%never deleted%' then v_pass := v_pass + 1; else v_fail := v_fail || ' FAIL 7(' || sqlerrm || ')'; end if;
  end;

  -- 8: resolving needs resolved_at (CHECK), and a resolved row is final
  begin
    update public.webhook_conflicts set status = 'applied' where id = v_id1;
    v_fail := v_fail || ' FAIL 8a';
  exception when check_violation then
    null;
  end;
  update public.webhook_conflicts set status = 'rejected', resolved_at = now(), resolution_note = 'probe' where id = v_id1;
  begin
    update public.webhook_conflicts set status = 'applied', resolved_at = now() where id = v_id1;
    v_fail := v_fail || ' FAIL 8b';
  exception when others then
    if sqlerrm like '%resolved row is final%' then v_pass := v_pass + 1; else v_fail := v_fail || ' FAIL 8b(' || sqlerrm || ')'; end if;
  end;

  -- 9: anon/authenticated cannot read the table (RLS on, no policies, no grants)
  reset role;
  set local role authenticated;
  begin
    perform 1 from public.webhook_conflicts limit 1;
    v_fail := v_fail || ' FAIL 9';
  exception when insufficient_privilege then
    v_pass := v_pass + 1;
  end;
  reset role;

  raise exception 'E2E-ROLLBACK WEBHOOK-CONFLICTS % %/9%',
    case when v_fail = '' and v_pass = 9 then 'PASS' else 'FAIL' end, v_pass, v_fail;
end $$;
