-- Release lifecycle on products: explicit state, release year, and one timestamp per stage.
-- A product is authoritative for sale only when all three consents are given. The agreement timestamp is the
-- last of those three consents (the C3 revenue split). That is derived in product_authority, not stored twice.
-- Stage timestamps are set by the workflow when each stage happens. Nothing is backfilled from guesses.

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

create or replace view public.product_authority as
select
  p.id as product_id,
  p.release_state,
  p.release_year,
  count(*) filter (where c.decision = 'given' and c.kind in ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split')) as given_consents,
  (count(distinct c.kind) filter (where c.decision = 'given' and c.kind in ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split')) = 3) as is_authoritative,
  case
    when count(distinct c.kind) filter (where c.decision = 'given' and c.kind in ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split')) = 3
    then max(c.created_at) filter (where c.decision = 'given' and c.kind in ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split'))
  end as agreement_signed_at
from public.products p
left join public.consents c on c.product_id = p.id
group by p.id, p.release_state, p.release_year;

comment on view public.product_authority is
  'Authoritative = all three consents given. agreement_signed_at = the last of those consents (the authority timestamp).';

-- The view runs with the caller's rights, so it must not bypass RLS on consents.
alter view public.product_authority set (security_invoker = true);
