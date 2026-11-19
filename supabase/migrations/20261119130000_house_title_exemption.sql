-- House title exemption (founder decision, 2026-11-19).
--
-- A house title is published by ExpanPress itself. It has no external creator,
-- so the creator consents C1 (data accuracy), C2 (release approval) and C3
-- (revenue split) protect nobody and are not required. This migration adds that
-- narrow exemption and keeps the release hash check:
--
--   * creators.is_house marks the house creator. Only the operator role can set
--     it (creators_is_house_guard; client roles hold no write grant).
--   * house_release_pins holds the release digest the operator verified against
--     the stored file (sha256sum of the object, sample listing plan step 5). A
--     house product launches only when release_sha256 equals its pin, so the
--     file must still match.
--   * launch_block_reason skips C1-C3 ONLY for is_house creators. Every other
--     creator keeps the unchanged C1-C3 chain and C2 hash path.
--
-- The checkout route (web/app/api/billing/checkout/route.ts) and the TypeScript
-- launch gate (payments/src/launch_gate.ts) apply the same rule. The pairwise
-- model (docs/testing/pairwise/billing_consent_checkout.model.txt) and the
-- PGlite test web/src/lib/__tests__/house-title-exemption.test.ts pin it.

alter table public.creators
  add column if not exists is_house boolean not null default false;

comment on column public.creators.is_house is
  'House title owner (ExpanPress). True skips creator consents C1-C3 at checkout and at the launch trigger. The release hash must still match house_release_pins. Operator-set only (creators_is_house_guard).';

-- Client roles never write this column. The table-level revoke (20261111152756) already
-- blocks them; this states the intent on the column itself.
revoke update (is_house) on public.creators from anon, authenticated;

-- Defense in depth: even a future grant cannot let a client role set the flag.
create or replace function public.creators_is_house_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.is_house)
     or (tg_op = 'UPDATE' and new.is_house is distinct from old.is_house) then
    if current_user not in ('postgres', 'service_role', 'supabase_admin') then
      raise exception 'creators.is_house is set by the operator only'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists creators_is_house_guard on public.creators;
create trigger creators_is_house_guard
  before insert or update of is_house on public.creators
  for each row execute function public.creators_is_house_guard();

create table if not exists public.house_release_pins (
  product_id uuid primary key references public.products(id) on delete restrict,
  sha256     text not null check (sha256 ~ '^[0-9a-f]{64}$' and sha256 <> repeat('0', 64)),
  pinned_at  timestamptz not null default now(),
  pinned_by  text not null default current_user
);

comment on table public.house_release_pins is
  'Release digest the operator verified against the stored house file (sha256sum of the object). The launch gate and checkout require products.release_sha256 to equal it.';

alter table public.house_release_pins enable row level security;
-- No policies. Server reads use service_role; writes happen by the operator role only.
revoke all on public.house_release_pins from public, anon, authenticated;
grant select on public.house_release_pins to service_role;

-- Launch gate: the house branch sits after the release hash validity check and before the consent chain.
-- Non-house creators run the same statements as 20261116142329.
create or replace function public.launch_block_reason(p_product_id uuid, p_creator_id uuid, p_release_sha256 text)
returns text
language plpgsql
volatile -- each statement takes a fresh snapshot, so rows committed while the
         -- caller waited on the consent locks are seen
set search_path = ''
as $$
declare
  v_release text := lower(btrim(coalesce(p_release_sha256, '')));
  v_house boolean;
  v_pinned text;
  v_approved text;
  v_active text[];
begin
  if p_creator_id is null then
    return 'product has no owner';
  end if;
  if v_release !~ '^[0-9a-f]{64}$' or v_release = repeat('0', 64) then
    return 'product has no valid release_sha256';
  end if;

  select c.is_house into v_house from public.creators c where c.id = p_creator_id;
  if coalesce(v_house, false) then
    -- House title: no C1/C2/C3 consent rows exist or are required. The file must still match its pin.
    select lower(btrim(hp.sha256)) into v_pinned
    from public.house_release_pins hp
    where hp.product_id = p_product_id;
    if v_pinned is distinct from v_release then
      return 'house release hash does not match the pinned release file';
    end if;
    return null;
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

revoke all on function public.launch_block_reason(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.creators_is_house_guard() from public, anon, authenticated;
