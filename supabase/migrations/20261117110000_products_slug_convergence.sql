-- Forward convergence for product slugs (ADR 0065). Written 2026-11-17 after the production audit.
--
-- Why: clean replay of this repo's history left products_slug_key (platform-wide UNIQUE) in place and
-- products_slug_check on the old 5-30 char rule. Production reverted both (20261111090604 and the
-- agreed rule, validated by 20261114215705). This file makes a fresh replay end in the production state.
--
-- Safe on production: products_slug_key is already absent, and products_slug_check already matches the
-- rule below, so both steps are no-ops there. Idempotent: rerunning changes nothing.
-- Locking: NOT VALID then VALIDATE (no ACCESS EXCLUSIVE scan of a live table).

-- 1. Platform-wide uniqueness is not the rule (per-creator uniqueness only). Drop it if a replay created it.
alter table public.products drop constraint if exists products_slug_key;

-- 2. Agreed rule: 3 to 30 chars, lowercase letters and digits joined by single underscores.
-- Always drop and re-add: the end state is the same on every database; products is a small table.
alter table public.products drop constraint if exists products_slug_check;
alter table public.products
  add constraint products_slug_check
  check (slug ~ '^[a-z0-9]+(_[a-z0-9]+)*$' and char_length(slug) between 3 and 30) not valid;
alter table public.products validate constraint products_slug_check;
