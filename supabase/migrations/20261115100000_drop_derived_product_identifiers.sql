-- Drop the derived product identifiers (ADR 0065).
--
-- A product is identified by its creator handle (creators.handle) and its product slug (products.slug).
-- products.composite_slug and products.site_slug were stored copies derived from those two values.
-- Nothing may derive an identifier from another stored identifier, so both columns are removed,
-- together with their unique constraints (default names from the inline "unique" in 20261007000000).
-- No other column, constraint or index is changed.

alter table public.products drop constraint if exists products_composite_slug_key;
alter table public.products drop constraint if exists products_site_slug_key;

alter table public.products drop column if exists composite_slug;
alter table public.products drop column if exists site_slug;
