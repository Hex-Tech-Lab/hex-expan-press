-- Drop the derived product identifiers (ADR 0065).
--
-- A product is identified by its creator handle (creators.handle) and its product slug (products.slug).
-- products.composite_slug and products.site_slug were stored copies derived from those two values.
-- Nothing may derive an identifier from another stored identifier, so both columns are removed,
-- together with their unique constraints (default names from the inline "unique" in 20261007000000).
-- No other column, constraint or index is changed.
--
-- Owner approval: ADR 0065 / docs/handover/THOS_KYC_ROLLING.md (2026-11-16, no remaining app readers).
-- Rollback (re-add columns, backfill from creators.handle + products.slug, then re-add unique constraints):
--   alter table public.products
--     add column if not exists composite_slug text,
--     add column if not exists site_slug text;
--   update public.products p
--     set composite_slug = c.handle || '-' || p.slug,
--         site_slug      = c.handle || '/' || p.slug
--   from public.creators c
--   where c.id = p.creator_id;
--   alter table public.products
--     add constraint products_composite_slug_key unique (composite_slug),
--     add constraint products_site_slug_key unique (site_slug);

alter table public.products
  drop constraint if exists products_composite_slug_key,
  drop constraint if exists products_site_slug_key,
  drop column if exists composite_slug,
  drop column if exists site_slug;
