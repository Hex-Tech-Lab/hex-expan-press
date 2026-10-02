-- Review question codes: section C renamed C1..C8 -> Q1..Q8.
-- audit_log history keeps the old C-codes on purpose (it's append-only evidence).
update public.review_items set code = 'Q' || substr(code, 2) where code ~ '^C[0-9]+$';
