# Pairwise Coverage: Storefront Listing & Legal Links Visibility (rev 2)

- **Branch:** `fix/email-streams-registry`
- **Model:** `docs/testing/pairwise/storefront_listing_and_legal.model.txt`
- **Generated rows:** `docs/testing/pairwise/storefront_listing_and_legal.rows.tsv` (**16 rows**, order 2, 7 factors)
- **PICT binary:** `/usr/local/bin/pict`
- **Pairwise coverage:** **135 / 135 pairs (100.0%)** — 0 uncovered pairs
- **Asserted by:** `web/__tests__/storefront_listing_and_legal.pairwise.test.ts` (17 tests: 1 drift check + 16 per-row assertions)

## Factors updated in rev 2

- Added `sandboxOpen` (`true`, `false`), matching the third argument of `isVisibleStorefrontProduct`, the second argument of `allowedStorefrontCheckoutModes` (`web/src/components/storefront/storefront.tsx`), and `isLaunchOpen(product, sandboxAllowed())` for `StorefrontFooter` legal links on product and checkout pages.

## Row mapping

| # | show_non_live_samples | allowed_modes | is_sample | checkout_mode | always_show_buyer_legal | buyer_surface | sandboxOpen | Expected listed | Expected legal visible |
|---:|---|---|---|---|---|---|---|---|---|
| 1 | `true` | `empty` | `true` | `sandbox` | `false` | `checkout_page` | `true` | `true` | `true` |
| 2 | `false` | `empty` | `false` | `null` | `true` | `product_page` | `false` | `false` | `true` |
| 3 | `true` | `gated_only` | `false` | `null` | `false` | `product_page` | `true` | `false` | `false` |
| 4 | `false` | `gated_and_sandbox` | `true` | `paddle` | `true` | `checkout_page` | `false` | `false` | `true` |
| 5 | `true` | `gated_only` | `true` | `live` | `true` | `checkout_page` | `false` | `true` | `true` |
| 6 | `false` | `gated_and_sandbox` | `false` | `null` | `false` | `checkout_page` | `true` | `false` | `false` |
| 7 | `false` | `gated_only` | `true` | `sandbox` | `true` | `product_page` | `false` | `false` | `true` |
| 8 | `true` | `gated_and_sandbox` | `false` | `sandbox` | `true` | `product_page` | `true` | `true` | `true` |
| 9 | `true` | `gated_and_sandbox` | `false` | `gated` | `false` | `checkout_page` | `false` | `false` | `false` |
| 10 | `false` | `empty` | `false` | `live` | `false` | `product_page` | `true` | `true` | `true` |
| 11 | `false` | `gated_only` | `true` | `gated` | `true` | `product_page` | `true` | `false` | `true` |
| 12 | `false` | `gated_and_sandbox` | `false` | `live` | `false` | `product_page` | `false` | `true` | `true` |
| 13 | `false` | `empty` | `true` | `gated` | `false` | `checkout_page` | `true` | `false` | `false` |
| 14 | `true` | `gated_only` | `false` | `paddle` | `false` | `product_page` | `true` | `false` | `false` |
| 15 | `false` | `empty` | `true` | `null` | `true` | `product_page` | `false` | `false` | `true` |
| 16 | `true` | `empty` | `true` | `paddle` | `true` | `checkout_page` | `false` | `false` | `true` |

## Uncovered combinations note

- Pairwise (order 2) pair coverage is **100.0% (135/135 pairs)**; no pair was omitted.
