-- Platform-wide product slug uniqueness, with a character rule chosen to fit the platform limits as we
-- understood them. Those limits come from secondary sources and are NOT verified against the platform
-- help centres (see web/src/lib/slug_rule.ts).
--
-- Before: products.slug was unique only per creator (UNIQUE (creator_id, slug)), so two creators
-- could hold the same slug. The bare-slug lookup this affects is noted in payments/src/webhook_core.ts.
--
-- Rule (decided 2026-11-10, founder decision): letters a-z and digits 0-9 only, 5 to 30 characters.
--   * Our understanding (unverified): Instagram allows letters, digits, periods and underscores, up to 30.
--   * Our understanding (unverified): Facebook allows letters, digits and periods, at least 5, no maximum.
--   * Letters and digits are common to both. Periods are excluded on purpose (see web/src/lib/slug_rule.ts).
--     Underscores are excluded because we understood Facebook not to allow them.
--
-- Data step (guarded): the duplicate test copy (creator 4dfac811, slug retirearly500k, site_slug null)
--   becomes testretirearly500k, the one-word fallback, since underscores and hyphens are not allowed.
--   The step raises only if more than one row matches. Zero matches (a fresh or branch database that
--   never had the test copy) is a no-op, so the migration applies everywhere.
--   Live state: the apply is recorded in docs/agent_ledger.jsonl (2026-11-10T12:40Z), which reports one row changed.
--
-- Legacy exception: test-book-1790377530060 (a tester fixture) keeps its hyphenated slug. The check
-- is NOT VALID: it applies to new rows and to any UPDATE of that row (an update to the fixture would fail the check),
-- and it is not checked against existing rows until the fixture is renamed and the constraint is VALIDATED.
-- Renaming that fixture needs a separate approval.

do $$
declare
  n int;
begin
  update public.products
     set slug = 'testretirearly500k'
   where creator_id = '4dfac811-94b5-42f1-a536-be28a9f76aba'
     and slug = 'retirearly500k'
     and site_slug is null;
  get diagnostics n = row_count;
  if n > 1 then
    raise exception 'slug rename: expected at most 1 test copy row, got %', n;
  end if;
end
$$;

alter table public.products drop constraint if exists products_slug_check;
alter table public.products
  add constraint products_slug_check check (slug ~ '^[a-z0-9]{5,30}$') not valid;

-- Platform-wide uniqueness. The per-creator key stays in place; this one is strictly stronger.
alter table public.products
  add constraint products_slug_key unique (slug);
