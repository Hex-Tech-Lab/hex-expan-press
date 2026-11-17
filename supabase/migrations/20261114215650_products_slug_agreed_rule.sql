-- Product slug: one rule everywhere, the same shape as creator handles (settings registry, handles section):
-- 3 to 30 characters, lowercase letters and digits, joined by single underscores. No hyphens.
-- Starting definition differs by database (drift, recorded in THOS 2026-11-14):
--   * test (wmagphohfsbjolssqctf): ^[a-z0-9]{5,30}$ from 20261110120000, which was applied there;
--   * production (hywqftbcjhfjegypzpzd): ^[a-z0-9-]{2,80}$. Its history shows 20261110121805
--     products_platform_slug_unique followed by 20261111090604 revert_product_slug_platform_unique, so the
--     platform-wide uniqueness and that rule were both reverted there.
-- Applied 2026-11-14: test (wmagphohfsbjolssqctf) and production (hywqftbcjhfjegypzpzd), as migration name
-- products_slug_agreed_rule (production then products_slug_agreed_rule_validate). Recorded server versions differ from this
-- file's timestamp; the name is the link. Rule and decision: docs/adr/0065-identifier-rules.md.
-- NOT VALID first, then VALIDATE (second migration products_slug_agreed_rule_validate). Before VALIDATE, the
-- hyphenated fixture test-book-1790377530060 was renamed to test_book_1790377530060 on production.
-- No test_ exception: test_ is a normal prefix under this rule, so test identifiers are valid by the rule itself.
alter table public.products drop constraint if exists products_slug_check;
alter table public.products add constraint products_slug_check
  check (slug ~ '^[a-z0-9]+(_[a-z0-9]+)*$' and char_length(slug) between 3 and 30) not valid;
