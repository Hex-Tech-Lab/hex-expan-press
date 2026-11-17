-- Reconciled 2026-11-17 from production supabase_migrations.schema_migrations (version 20261111090604); SQL as applied.
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
