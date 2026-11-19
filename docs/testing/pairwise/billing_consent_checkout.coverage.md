# Pairwise Coverage: Billing / Consent / Checkout (rev 3)

- **Branch:** `fix/funnel-kyc-buildable` (rev 3 adds `provider_path` (`overlay` vs `redirect`) and webhook `buyer_consent` persistence to rev 2)
- **Model:** `docs/testing/pairwise/billing_consent_checkout.model.txt`
- **Generated rows:** `docs/testing/pairwise/billing_consent_checkout.rows.tsv` (**45 rows**, order 2, 12 factors)
- **PICT binary:** `/usr/local/bin/pict`
- **Asserted by:** `web/app/api/billing/checkout/__tests__/billing_consent_checkout.pairwise.test.ts`, one test per row, against `billing_consent_checkout.oracle.ts`
- **Outcomes across the 45 rows:** 12 x 400 Bad Request; 29 x 403 Forbidden; 1 x 404 Not Found; 3 x 409 Conflict

## Factors added in rev 3

- `provider_path`: `overlay` (Paddle.js overlay JSON via `POST /api/billing/checkout` `Accept: application/json`) vs `redirect` (`GET /api/billing/checkout` 302). Constrained to `redirect` for non-Paddle providers and non-rail error states.
- `buyer_consent` end-to-end verification: `checked` (`"true"`) and `unchecked` (`"false"`) carried in Paddle overlay `customData.buyer_consent`, verified through signed `transaction.completed` webhook parsing (`PaddleAdapter`) and `orders.buyer_email_consent` persistence (with `redirect` / absent consent remaining `NULL`).

## Row mapping

| # | consent_kind | decision | provider | provider_path | checkout_mode | sandbox_flag | vercel_env | product_state | rail_mode | buyer_email | buyer_consent | buyer_country | Expected HTTP | Asserted by |
|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `C2_release_approval` | `forked` | `paddle` | `redirect` | `live` | `true` | `production` | `release_hash_mismatch` | `live` | `absent` | `checked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #1 |
| 2 | `C3_revenue_split` | `resolved_by_set` | `fungies` | `redirect` | `sandbox` | `false` | `production` | `active_rail` | `sandbox` | `valid` | `unchecked` | `us_territory` | 403 | billing_consent_checkout.pairwise.test.ts row #2 |
| 3 | `C1_data_accuracy` | `given` | `polar` | `redirect` | `gated` | `true` | `production` | `active_rail` | `live` | `invalid` | `unchecked` | `us` | 400 (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #3 |
| 4 | `C3_revenue_split` | `refused` | `paddle` | `redirect` | `live` | `false` | `development` | `bare_slug_single` | `live` | `typo_suggested` | `unchecked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #4 |
| 5 | `C2_release_approval` | `given` | `paddle` | `redirect` | `sandbox` | `false` | `unset_node_prod` | `bare_slug_ambiguous` | `live` | `valid` | `checked` | `us` | 409 (product_slug_ambiguous) | billing_consent_checkout.pairwise.test.ts row #5 |
| 6 | `C1_data_accuracy` | `resolved_by_set` | `paddle` | `redirect` | `gated` | `true` | `unset_node_prod` | `bare_slug_single` | `live` | `invalid` | `checked` | `us_territory` | 400 (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #6 |
| 7 | `C2_release_approval` | `refused` | `paddle` | `overlay` | `gated` | `true` | `unset_node_test` | `active_rail` | `sandbox` | `typo_suggested` | `checked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #7 |
| 8 | `C1_data_accuracy` | `forked` | `lemonsqueezy` | `redirect` | `live` | `false` | `production` | `active_rail` | `sandbox` | `absent` | `unchecked` | `us` | 403 | billing_consent_checkout.pairwise.test.ts row #8 |
| 9 | `C3_revenue_split` | `refused` | `paddle` | `redirect` | `sandbox` | `true` | `preview` | `bare_slug_ambiguous` | `live` | `absent` | `unchecked` | `us_territory` | 409 (product_slug_ambiguous) | billing_consent_checkout.pairwise.test.ts row #9 |
| 10 | `C1_data_accuracy` | `forked` | `paddle` | `redirect` | `sandbox` | `false` | `unset_node_test` | `bare_slug_ambiguous` | `live` | `invalid` | `unchecked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #10 |
| 11 | `C3_revenue_split` | `given` | `paddle` | `redirect` | `live` | `true` | `development` | `no_rails` | `live` | `valid` | `checked` | `us_territory` | 404 | billing_consent_checkout.pairwise.test.ts row #11 |
| 12 | `C3_revenue_split` | `forked` | `creem` | `redirect` | `gated` | `false` | `preview` | `active_rail` | `sandbox` | `typo_suggested` | `checked` | `us` | 403 | billing_consent_checkout.pairwise.test.ts row #12 |
| 13 | `C1_data_accuracy` | `given` | `fungies` | `redirect` | `live` | `true` | `unset_node_prod` | `active_rail` | `sandbox` | `typo_suggested` | `unchecked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #13 |
| 14 | `C2_release_approval` | `refused` | `lemonsqueezy` | `redirect` | `sandbox` | `true` | `unset_node_prod` | `active_rail` | `live` | `typo_suggested` | `checked` | `us_territory` | 403 | billing_consent_checkout.pairwise.test.ts row #14 |
| 15 | `C2_release_approval` | `resolved_by_set` | `paddle` | `redirect` | `sandbox` | `false` | `development` | `release_hash_mismatch` | `live` | `invalid` | `unchecked` | `us` | 400 (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #15 |
| 16 | `C3_revenue_split` | `forked` | `polar` | `redirect` | `live` | `false` | `unset_node_prod` | `active_rail` | `sandbox` | `absent` | `checked` | `us_territory` | 403 | billing_consent_checkout.pairwise.test.ts row #16 |
| 17 | `C1_data_accuracy` | `resolved_by_set` | `paddle` | `redirect` | `live` | `false` | `production` | `bare_slug_ambiguous` | `live` | `typo_suggested` | `unchecked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #17 |
| 18 | `C3_revenue_split` | `refused` | `fungies` | `redirect` | `gated` | `false` | `unset_node_test` | `active_rail` | `live` | `absent` | `checked` | `us` | 403 | billing_consent_checkout.pairwise.test.ts row #18 |
| 19 | `C1_data_accuracy` | `refused` | `paddle` | `redirect` | `sandbox` | `false` | `production` | `bare_slug_single` | `live` | `valid` | `unchecked` | `us` | 400 (product_ref_requires_handle) | billing_consent_checkout.pairwise.test.ts row #19 |
| 20 | `C3_revenue_split` | `given` | `lemonsqueezy` | `redirect` | `gated` | `false` | `unset_node_test` | `active_rail` | `live` | `valid` | `unchecked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #20 |
| 21 | `C2_release_approval` | `resolved_by_set` | `lemonsqueezy` | `redirect` | `live` | `false` | `preview` | `active_rail` | `sandbox` | `invalid` | `unchecked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #21 |
| 22 | `C1_data_accuracy` | `refused` | `paddle` | `redirect` | `live` | `false` | `unset_node_test` | `release_hash_mismatch` | `live` | `valid` | `unchecked` | `us_territory` | 403 | billing_consent_checkout.pairwise.test.ts row #22 |
| 23 | `C1_data_accuracy` | `given` | `creem` | `redirect` | `live` | `true` | `development` | `active_rail` | `live` | `absent` | `unchecked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #23 |
| 24 | `C1_data_accuracy` | `forked` | `paddle` | `redirect` | `sandbox` | `false` | `preview` | `bare_slug_single` | `live` | `valid` | `unchecked` | `us_territory` | 400 (product_ref_requires_handle) | billing_consent_checkout.pairwise.test.ts row #24 |
| 25 | `C3_revenue_split` | `refused` | `creem` | `redirect` | `sandbox` | `false` | `unset_node_test` | `active_rail` | `live` | `invalid` | `unchecked` | `us_territory` | 400 (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #25 |
| 26 | `C2_release_approval` | `forked` | `paddle` | `redirect` | `sandbox` | `false` | `production` | `no_rails` | `live` | `invalid` | `unchecked` | `us` | 400 (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #26 |
| 27 | `C2_release_approval` | `forked` | `fungies` | `redirect` | `live` | `false` | `preview` | `active_rail` | `live` | `invalid` | `unchecked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #27 |
| 28 | `C2_release_approval` | `resolved_by_set` | `polar` | `redirect` | `sandbox` | `false` | `preview` | `active_rail` | `live` | `typo_suggested` | `unchecked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #28 |
| 29 | `C1_data_accuracy` | `resolved_by_set` | `paddle` | `redirect` | `gated` | `false` | `unset_node_test` | `no_rails` | `live` | `absent` | `unchecked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #29 |
| 30 | `C2_release_approval` | `forked` | `paddle` | `redirect` | `gated` | `false` | `development` | `bare_slug_ambiguous` | `live` | `valid` | `unchecked` | `us_territory` | 409 (product_slug_ambiguous) | billing_consent_checkout.pairwise.test.ts row #30 |
| 31 | `C2_release_approval` | `forked` | `lemonsqueezy` | `redirect` | `live` | `false` | `development` | `active_rail` | `sandbox` | `typo_suggested` | `unchecked` | `us` | 403 | billing_consent_checkout.pairwise.test.ts row #31 |
| 32 | `C3_revenue_split` | `refused` | `fungies` | `redirect` | `sandbox` | `false` | `development` | `active_rail` | `live` | `typo_suggested` | `unchecked` | `us_territory` | 403 | billing_consent_checkout.pairwise.test.ts row #32 |
| 33 | `C2_release_approval` | `given` | `paddle` | `redirect` | `live` | `false` | `unset_node_test` | `bare_slug_single` | `live` | `absent` | `unchecked` | `us_territory` | 400 (product_ref_requires_handle) | billing_consent_checkout.pairwise.test.ts row #33 |
| 34 | `C2_release_approval` | `resolved_by_set` | `creem` | `redirect` | `sandbox` | `false` | `unset_node_prod` | `active_rail` | `live` | `valid` | `unchecked` | `us` | 403 | billing_consent_checkout.pairwise.test.ts row #34 |
| 35 | `C1_data_accuracy` | `refused` | `paddle` | `redirect` | `live` | `false` | `preview` | `no_rails` | `live` | `typo_suggested` | `unchecked` | `us` | 403 | billing_consent_checkout.pairwise.test.ts row #35 |
| 36 | `C1_data_accuracy` | `given` | `paddle` | `overlay` | `sandbox` | `false` | `unset_node_prod` | `active_rail` | `live` | `valid` | `unchecked` | `us_territory` | 403 | billing_consent_checkout.pairwise.test.ts row #36 |
| 37 | `C3_revenue_split` | `given` | `paddle` | `redirect` | `gated` | `true` | `unset_node_prod` | `release_hash_mismatch` | `live` | `typo_suggested` | `checked` | `us` | 403 | billing_consent_checkout.pairwise.test.ts row #37 |
| 38 | `C2_release_approval` | `refused` | `polar` | `redirect` | `live` | `true` | `unset_node_test` | `active_rail` | `sandbox` | `valid` | `unchecked` | `us` | 403 | billing_consent_checkout.pairwise.test.ts row #38 |
| 39 | `C3_revenue_split` | `forked` | `paddle` | `overlay` | `live` | `true` | `production` | `active_rail` | `sandbox` | `absent` | `checked` | `us` | 400 (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #39 |
| 40 | `C3_revenue_split` | `given` | `paddle` | `redirect` | `sandbox` | `true` | `preview` | `release_hash_mismatch` | `live` | `invalid` | `checked` | `us` | 400 (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #40 |
| 41 | `C1_data_accuracy` | `given` | `creem` | `redirect` | `gated` | `true` | `production` | `active_rail` | `sandbox` | `invalid` | `checked` | `us` | 400 (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #41 |
| 42 | `C1_data_accuracy` | `resolved_by_set` | `paddle` | `overlay` | `sandbox` | `true` | `preview` | `active_rail` | `live` | `invalid` | `checked` | `us` | 400 (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #42 |
| 43 | `C1_data_accuracy` | `refused` | `paddle` | `redirect` | `live` | `true` | `unset_node_prod` | `no_rails` | `live` | `typo_suggested` | `checked` | `us` | 403 | billing_consent_checkout.pairwise.test.ts row #43 |
| 44 | `C1_data_accuracy` | `forked` | `paddle` | `overlay` | `live` | `false` | `development` | `active_rail` | `live` | `typo_suggested` | `unchecked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #44 |
| 45 | `C3_revenue_split` | `forked` | `polar` | `redirect` | `live` | `true` | `development` | `active_rail` | `live` | `valid` | `unchecked` | `non_us` | 403 (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #45 |

## Explicit paths (outside the PICT rows)

Nine named cases in the same test file, outside the PICT rows:

- `resolved_by_set` + `paddle` + `redirect` + `live` + `production` + live rail: 302 Found.
- `resolved_by_set` + `paddle` + `redirect` + `sandbox` + sandbox flag on + `development` + sandbox rail: 302 Found.
- `given` + `paddle` + `redirect` + `sandbox` without the sandbox flag + `development` + sandbox rail: 403 Forbidden.
- `given` + `paddle` + `redirect` + `live` + sandbox flag on + `preview` + sandbox rail (rail mode mismatch): 500 Internal Server Error.
- `given` + `paddle` + `redirect` + `sandbox` + sandbox flag on + `development` + live rail (rail mode mismatch): 500 Internal Server Error.
- `given` + `creem` + `redirect` + `live` + `production` + live rail with buyer consent checked: 302 Found, consent carried as creem metadata.
- `given` + `paddle` + `redirect` + `live` + `production` + live rail with buyer consent checked: 302 Found, `user_email` prefilled, no consent parameter (webhook stores `NULL`).
- `given` + `paddle` + `overlay` + `live` + `production` + live rail with `buyer_consent = checked`: 200 OK overlay payload (`customData.buyer_consent = "true"`), verified through `PaddleAdapter` `transaction.completed` webhook -> `buyerEmailConsent === true`.
- `given` + `paddle` + `overlay` + `live` + `production` + live rail with `buyer_consent = unchecked`: 200 OK overlay payload (`customData.buyer_consent = "false"`), verified through `PaddleAdapter` `transaction.completed` webhook -> `buyerEmailConsent === false`.

**Why these exist.** Masking gates (refused heads, gated launch, bare slugs, non-US geo) hide the reachable 200 overlay, 302 redirect, and 500 rail-mode mismatch outcomes in the generated rows. Pairwise coverage counts pairs, not reachable outcomes, so those paths and the overlay-to-webhook `buyer_consent` chain are asserted explicitly.
