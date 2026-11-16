# 0065 — One identifier rule for creator handles and product slugs

**Status:** Accepted
**Date:** 2026-11-14 (date the decision was made by the founder)
**Supersedes:** the product-slug rules in `20261110120000` (`^[a-z0-9]{5,30}$`, test DB) and the hyphen rule `^[a-z0-9-]{2,80}$` (production, after `20261111090604` reverted the platform-wide slug fix), and the storefront regex that mirrored the hyphen rule.
**Superseded-by:** — (still standing)

## Context

The same identifier rule had been decided more than once and then drifted. Three product-slug definitions existed at once: the test DB CHECK, the production CHECK, and the storefront gate. The creator handle rule (`20261113000000`, settings registry `handles` block) was correct, but it was never carried to products. Production's platform-wide slug fix was reverted, and nothing recorded that revert in one place the next session would read. The result was repeated re-litigation of settled points.

## Decision

1. **One shape for every creator handle and product slug:** 3 to 30 characters, lowercase letters and digits, joined by single underscores. No leading, trailing or doubled underscore. No hyphens. No periods. Instagram allows letters, digits, periods and underscores, 1 to 30 characters, with no leading, trailing or doubled period (checked by search, 2026-11-14). Our rule is that set without periods. The period-to-underscore conversion is our own sign-up default (memory: feedback-default-handle-from-instagram), not a platform behaviour.
2. **Source of truth is the settings registry.** `handles` and `product_slug` (`payments/src/settings_registry.ts`) hold the values. App validation is built from them with Zod (`web/src/lib/identifier-rule.ts`). The DB CHECK carries the same values in SQL. `web/src/lib/__tests__/identifier-rule.test.ts` fails if the migration text drifts from the registry.
3. **Product slugs are unique per creator, not platform-wide** (`products_creator_id_slug_key`). Two creators may hold the same product slug. Lookups by bare slug are therefore ambiguous and must resolve through the creator handle and product slug.
4. **No built-in `test_` exception.** `test_` is an ordinary prefix under rule 1, so test identifiers already pass. Test isolation is by environment (the test database `hex-expan-test`), not by a name prefix in the live namespace.
5. **Applied:** test DB (`wmagphohfsbjolssqctf`) and production (`hywqftbcjhfjegypzpzd`) `products_slug_check` replaced with the rule above, `NOT VALID` then `VALIDATE`. The test DB global `products_slug_key` dropped to match production's creator-scoped uniqueness. Two production products renamed to `test_` identifiers (founder test copy `test_retirearly500k`; E2E fixture `test_book_1790377530060`).
6. **Not applied:** deletion of the founder test copy (`cd9ec10d-…`). It has 2 `consents` rows and 22 `review_items` rows. Consents are signed evidence; deleting them is out of bounds without a separate decision.

## Consequences / Tradeoffs

- Easier: one rule to explain, test and change. A `test_` identifier needs no special case.
- Harder: a rule change means changing the registry, a migration, and the parity test together. That is deliberate.
- Accepted cost: underscores are less pretty than periods.
- Done 2026-11-16: the checkout route no longer resolves a bare slug. It accepts a product id or `<handle>/<product_slug>`; a bare slug answers 409 when more than one creator shares it and 400 otherwise (404 when no product matches).
- Done 2026-11-16: the checkout alias map is removed. Its two aliases no longer resolve: the duane form is a bare slug and answers 404; the hyphenated form fails the identifier rule and answers 400.
- Standing rule created: before proposing an identifier or policy change, read this ADR and the THOS RESUME block. Do not re-open a decision recorded here without new evidence.

## Sources

- `docs/handover/THOS_KYC_ROLLING.md` turn logs 2026-11-14 (23:25 Cairo and the entries before it).
- `supabase/migrations/20261110120000_products_platform_slug_unique.sql`; `20261111090604` revert on production (`list_migrations`, 2026-11-14).
- `supabase/migrations/20261113000000_handle_shape.sql` (handle rule); `supabase/migrations/20261114130000_products_slug_agreed_rule.sql` (product rule).
- Founder decisions, 2026-11-14: creator-based product slugs; Option A (no `test_` exception); rule from the settings register; Zod for validation; delete the test copy only with a separate decision.

## Amendment 2026-11-15 (a): Instagram claim corrected

Decision 1 said Instagram itself converts periods to underscores. That was false. Instagram allows periods. The conversion is our sign-up default. The rule itself is unchanged.

## Amendment 2026-11-15 (b): what the code does (Zod claim corrected)

- **Zod, measured:** Zod is a dependency (`package.json`, `web/package.json`). The identifier and purchase-path checks now use Zod: `web/src/lib/identifier-rule.ts` (handle and product rule, from the registry), `web/src/lib/zod-rules.ts` (product reference and guid), `web/src/lib/review-anchor.ts` (page anchor), and the checkout and storefront gates that use them.
- **Still regex (validators):** 33 lines in non-test app code (`web/src`, `web/app`, `payments/src`) use `.test(`, `new RegExp` or a `/^…/` literal. A broader pattern also matches string replace calls (46 lines total); those are not validators and are not counted here. Four app files import Zod. The earlier "Zod exclusively" and "26 sites" statements were wrong; the measured figures are these. Converting the remaining validators is an open task (`docs/handover/KYC_TODO.md`, D3).
- **Retired alias:** the checkout URL aliases `duane_retirement_playbook_v1` and `retirearly500k-500k-playbook` are removed. Canonical destination only: a product reference that passes the rule resolves by `<handle>/<product_slug>` or `id` (bare-slug resolution was removed on 2026-11-16; see Consequences). `store_product_id` = `duane_retirement_playbook_v1` remains on Duane's product as the provider key used by webhook matching. It is replaced when the provider product is created (KYC_TODO E2).
- **Review gate:** a review question without a page anchor is not served and the viewer no longer falls back to page 1.
