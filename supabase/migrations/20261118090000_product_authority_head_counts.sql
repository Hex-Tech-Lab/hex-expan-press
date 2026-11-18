-- product_authority: count consent heads per kind instead of picking the newest row (PR #136 review, P1 + P2).
--
-- Problem: `DISTINCT ON (product_id, kind) ... ORDER BY signed_at DESC` hid every other live head of a
-- forked chain, so a product with two live heads for one kind could report is_authoritative = true.
-- It also broke signed_at ties arbitrarily (no tie-breaker).
--
-- Fix (additive: the view is replaced, no table or data changes):
--   * A head is a consent row that no same-creator, same-kind row names in `supersedes` or
--     `supersedes_ids`. This is the rule strict_active_consent_kinds uses (20261116142329).
--   * A kind counts as given only when exactly one head exists for it and that head is 'given'.
--   * No DISTINCT ON, so no tie-break is needed: two heads is a fork, and a fork is never authoritative.
--   * The six original columns keep their names, order and types. New head-count columns are appended.
--
-- Live check (2026-11-18, read-only): no (product, kind) has a head count other than 1 today, so the
-- output for existing products is unchanged.

create or replace view public.product_authority
with (security_invoker = true) as
with heads as (
  select c.product_id, c.kind, c.decision, c.signed_at
  from public.consents c
  where c.kind in ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split')
    and not exists (
      select 1
      from public.consents s
      where s.creator_id = c.creator_id
        and s.kind = c.kind
        and (s.supersedes = c.id or c.id = any (s.supersedes_ids))
    )
),
per_kind as (
  select h.product_id, h.kind, count(*) as head_count, min(h.decision) as decision, max(h.signed_at) as signed_at
  from heads h
  group by h.product_id, h.kind
),
slots as (
  select
    p.id as product_id,
    k.kind,
    coalesce(pk.head_count, 0) as head_count,
    (coalesce(pk.head_count, 0) = 1 and coalesce(pk.decision, '') = 'given') as kind_given,
    case when coalesce(pk.head_count, 0) = 1 and coalesce(pk.decision, '') = 'given' then pk.signed_at end as signed_at
  from public.products p
  cross join (values
    ('C1_data_accuracy'::public.consent_kind),
    ('C2_release_approval'::public.consent_kind),
    ('C3_revenue_split'::public.consent_kind)
  ) as k(kind)
  left join per_kind pk on pk.product_id = p.id and pk.kind = k.kind
)
select
  p.id as product_id,
  p.release_state,
  p.release_year,
  count(*) filter (where s.kind_given) as given_consents,
  count(*) filter (where s.kind_given) = 3 as is_authoritative,
  case when count(*) filter (where s.kind_given) = 3 then max(s.signed_at) end as agreement_signed_at,
  coalesce(max(s.head_count) filter (where s.kind = 'C1_data_accuracy'), 0) as c1_head_count,
  coalesce(max(s.head_count) filter (where s.kind = 'C2_release_approval'), 0) as c2_head_count,
  coalesce(max(s.head_count) filter (where s.kind = 'C3_revenue_split'), 0) as c3_head_count
from public.products p
left join slots s on s.product_id = p.id
group by p.id, p.release_state, p.release_year;

comment on view public.product_authority is
  'Authoritative = each of C1, C2 and C3 has exactly one unsuperseded head and that head is given. A fork (more than one head for a kind) is never authoritative. agreement_signed_at = the latest signed_at of the three heads when authoritative. c*_head_count = unsuperseded heads per kind.';
