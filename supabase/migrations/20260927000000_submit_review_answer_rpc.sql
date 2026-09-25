-- Portal step 2 (ADR 0048): creators submit review answers via RPC.
-- Clients have no write policies on review_answers/audit_log (append-only, private.forbid_mutation),
-- so the write happens here: SECURITY DEFINER, empty search_path, membership check first.

create or replace function public.submit_review_answer(item_id uuid, choice text, free_text text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller    uuid := (select auth.uid());
  v_product uuid;
  v_creator uuid;
  v_answer  uuid;
  v_code    text;
begin
  if caller is null then
    raise exception 'not authenticated';
  end if;

  select ri.product_id, ri.code into v_product, v_code
  from public.review_items ri
  where ri.id = item_id;

  if v_product is null then
    raise exception 'review item not found';
  end if;

  -- the item must belong to one of the caller's creators (private.my_creator_ids())
  select p.creator_id into v_creator
  from public.products p
  where p.id = v_product
    and p.creator_id in (select private.my_creator_ids());

  if v_creator is null then
    raise exception 'review item not found';
  end if;

  if nullif(trim(choice), '') is null and nullif(trim(free_text), '') is null then
    raise exception 'an answer requires a choice or free text';
  end if;

  insert into public.review_answers (item_id, choice, free_text, answered_by)
  values (item_id, nullif(trim(choice), ''), nullif(trim(free_text), ''), caller)
  returning id into v_answer;

  insert into public.audit_log (actor, creator_id, event, details)
  values (caller, v_creator, 'review_answer_submitted',
          jsonb_build_object('item_id', item_id, 'code', v_code, 'answer_id', v_answer));

  return v_answer;
end $$;

revoke all on function public.submit_review_answer(uuid, text, text) from public, anon;
grant execute on function public.submit_review_answer(uuid, text, text) to authenticated;
