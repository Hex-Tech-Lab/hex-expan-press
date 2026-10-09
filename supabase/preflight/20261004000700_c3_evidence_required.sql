-- READ-ONLY preflight for migration 20261004000700_c3_given_requires_evidence.sql.
-- Run in the SQL editor BEFORE applying. Expected result: zero rows. Any row blocks the migration
-- (the migration re-checks and aborts on its own, so skipping this is safe but noisy).
select id, product_id, signed_by, signed_at, external_ref
from public.consents
where kind = 'C3_revenue_split' and decision = 'given' and evidence_path is null
order by signed_at;
