-- Review question codes: section C renamed C1..C8 -> Q1..Q8.
-- audit_log history keeps the old C-codes on purpose (it's append-only evidence).
-- Guarded: skip a row whose Q twin already exists (e.g. the new seed ran first),
-- so the unique (product_id, code) constraint can never abort the migration.
update public.review_items r
set code = 'Q' || substr(r.code, 2)
where r.code ~ '^C[0-9]+$'
  and not exists (
    select 1 from public.review_items q
    where q.product_id = r.product_id and q.code = 'Q' || substr(r.code, 2)
  );
