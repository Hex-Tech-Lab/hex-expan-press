-- Paddle product ids must map to exactly one product. productForAlias() uses maybeSingle(),
-- which raises PGRST116 on duplicates and turns every sale for that product into a 5xx retry loop.
-- Partial index: rows without a Paddle id stay unconstrained.
create unique index if not exists products_paddle_product_id_key
  on public.products (paddle_product_id)
  where paddle_product_id is not null;
