-- Reconciled 2026-11-17 from production supabase_migrations.schema_migrations (version 20261103134245); SQL as applied.
alter table public.products
  add column if not exists release_state text not null default 'draft'
    check (release_state in ('draft', 'proof', 'release')),
  add column if not exists release_year integer
    check (release_year is null or release_year between 2000 and 2100),
  add column if not exists work_started_at timestamptz,
  add column if not exists draft_at timestamptz,
  add column if not exists proof_approved_at timestamptz,
  add column if not exists released_at timestamptz;

comment on column public.products.release_state is
  'Lifecycle state of the stored file: draft (_draft suffix), proof (_proof suffix), release (no suffix, the buyer copy).';
comment on column public.products.release_year is
  'Calendar year of release. Independent of work_started_at; a book started in December can be released in January of the next year.';

create or replace view public.product_authority
with (security_invoker = true) as
with latest as (
  select distinct on (product_id, kind) product_id, kind, decision, signed_at
  from public.consents
  where kind in ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split')
  order by product_id, kind, signed_at desc
)
select
  p.id as product_id,
  p.release_state,
  p.release_year,
  count(*) filter (where l.decision = 'given') as given_consents,
  count(*) filter (where l.decision = 'given') = 3 as is_authoritative,
  case when count(*) filter (where l.decision = 'given') = 3
       then max(l.signed_at) end as agreement_signed_at
from public.products p
left join latest l on l.product_id = p.id
group by p.id, p.release_state, p.release_year;

comment on view public.product_authority is
  'Authoritative = the latest decision for each of C1, C2 and C3 is given. agreement_signed_at = the latest of those three signed_at values.';
