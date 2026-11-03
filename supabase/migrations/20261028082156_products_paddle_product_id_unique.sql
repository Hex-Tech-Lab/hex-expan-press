-- Paddle product ids must map to exactly one product. productForAlias() uses maybeSingle(),
-- which raises PGRST116 on duplicates and turns every sale for that product into a 5xx retry loop.
-- Precondition: no two products may share a non-null paddle_product_id. The build fails otherwise, and the migration
-- contains no dedupe. Check first: select paddle_product_id from public.products where paddle_product_id is not null group by 1 having count(*) > 1;
-- Checked 2026-11-03 on the live project: that query returns no rows.
-- Partial index: rows without a Paddle id stay unconstrained.
create unique index if not exists products_paddle_product_id_key
  on public.products (paddle_product_id)
  where paddle_product_id is not null;
