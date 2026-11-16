-- Platform-wide product slug uniqueness, with a character rule that both Instagram and Facebook allow.
--
-- Before: products.slug was unique only per creator (UNIQUE (creator_id, slug)), so two creators
-- could hold the same slug, and a bare-slug lookup then failed closed with a 500 (see
-- docs/handover/THOS_2026-11-09_slug-rca-and-outbox.md).
--
-- Rule (approved 2026-11-10): letters a-z and digits 0-9 only, 5 to 30 characters.
--   * Instagram allows letters, digits, periods and underscores, up to 30 characters.
--   * Facebook allows letters, digits and periods only, at least 5 characters, no maximum.
--   * The rule above is the set both allow: no periods, no underscores, no hyphens.
--
-- Data step (guarded, each step asserts exactly one row so it fails loudly if the data differs):
--   * The duplicate test copy (creator kelly_test, slug retirearly500k, site_slug null) becomes
--     testretirearly500k: the one-word fallback, since underscores and hyphens are not in the shared set.
--     Duane's real product (site_slug retirearly500k/500k-playbook) keeps its slug.
--
-- Legacy exception: test-book-1790377530060 (a tester fixture) keeps its hyphenated slug. The check
-- is NOT VALID, so it applies to new rows and to any update of a row, not to existing ones.
-- Renaming that fixture needs a separate approval.

do $$
declare
  n int;
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'products'
       and column_name = 'site_slug'
  ) then
    execute '
      update public.products
         set slug = ''testretirearly500k''
       where creator_id = ''4dfac811-94b5-42f1-a536-be28a9f76aba''
         and slug = ''retirearly500k''
         and site_slug is null
    ';
    get diagnostics n = row_count;
    if n > 1 then
      raise exception 'slug rename: expected at most 1 test copy row, got %', n;
    end if;
  end if;
end
$$;

alter table public.products drop constraint if exists products_slug_check;
alter table public.products
  add constraint products_slug_check check (slug ~ '^[a-z0-9]{5,30}$') not valid;

-- Platform-wide uniqueness. The per-creator key stays in place; this one is strictly stronger.
do $$
begin
  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'products'
       and c.conname = 'products_slug_key'
  ) and to_regclass('public.products_slug_key') is null then
    alter table public.products
      add constraint products_slug_key unique (slug);
  end if;
end
$$;
