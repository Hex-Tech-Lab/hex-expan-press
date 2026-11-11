-- Reverts the platform-wide product slug rule (20261110121805_products_platform_slug_unique.sql).
-- Decision 2026-11-11: a product slug is unique per creator, as it was before. Creator handles are the
-- platform-wide identifier (creators.handle), so the product slug does not need a platform-wide key.
--
-- Order matters: the platform-wide key must be dropped before the test copy is renamed back, or the
-- rename collides with an existing creator's retirearly500k. (A first attempt at the other order failed and changed nothing.)
--
-- Restores:
--   * drops products_slug_key (UNIQUE (slug), platform-wide)
--   * drops products_slug_check and restores the original from 20260926000000_creator_portal.sql
--   * renames the test copy back to its original slug (guarded: zero matches is a no-op)

alter table public.products drop constraint if exists products_slug_key;
alter table public.products drop constraint if exists products_slug_check;

do $$
declare
  n int;
begin
  update public.products
     set slug = 'retirearly500k'
   where creator_id = '4dfac811-94b5-42f1-a536-be28a9f76aba'
     and slug = 'testretirearly500k'
     and site_slug is null;
  get diagnostics n = row_count;
  if n > 1 then
    raise exception 'slug revert: expected at most 1 test copy row, got %', n;
  end if;
end
$$;

alter table public.products
  add constraint products_slug_check check (slug ~ '^[a-z0-9-]{2,80}$');
