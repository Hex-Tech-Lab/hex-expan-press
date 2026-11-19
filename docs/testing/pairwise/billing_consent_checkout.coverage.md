# Pairwise Coverage: Billing / Consent / Checkout (rev 2)

- **Branch:** `fix/funnel-kyc-buildable` (rev 2 adds the factors below to the rev 1 model that covered 34 rows at `0498dfe`)
- **Model:** `docs/testing/pairwise/billing_consent_checkout.model.txt`
- **Generated rows:** `docs/testing/pairwise/billing_consent_checkout.rows.tsv` (**42 rows**, order 2, 11 factors)
- **PICT binary:** `/usr/local/bin/pict`
- **Asserted by:** `web/app/api/billing/checkout/__tests__/billing_consent_checkout.pairwise.test.ts`, one test per row, against `billing_consent_checkout.oracle.ts`
- **2-way pair coverage over the valid space:** **629 / 629** pairs covered (100%). The model forbids, by constraint, a non-rail product state with a non-paddle provider or a sandbox rail.
- **Outcomes across the 42 rows:** 1 x 302 Found; 9 x 400 Bad Request; 28 x 403 Forbidden; 2 x 404 Not Found; 2 x 409 Conflict

## Factors added in rev 2

- `provider`: creem is routable in the test world only (a test override of `isEnabledPaymentProvider`). Production settings keep creem switched off.
- `rail_mode`: host class of the active rail's checkout URL. A mismatch with `checkout_mode` is refused as 500 Internal Server Error.
- `buyer_email`: absent, valid, invalid shape (400 Bad Request), or typo suggested (valid shape, accepted unchanged; the suggestion is UI-only).
- `buyer_consent`: checked (`true`) or unchecked (`false`); carried to the creem link as metadata.
- `buyer_country`: US, a US territory (PR, VI, GU, AS, MP), or outside the allow list (403 Forbidden, `country_not_supported`).
- `product_state` now means rail presence only (`active_rail`); the rail host class moved to `rail_mode`.

The rev 1 "Before" column (coverage by the earlier suites) is not carried into rev 2. It was not recomputed for the new factors, so this report claims only what the pairwise test asserts.

## Row mapping

| # | consent_kind | decision | provider | checkout_mode | sandbox_flag | vercel_env | product_state | rail_mode | buyer_email | buyer_consent | buyer_country | Expected HTTP | Asserted by |
|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `C2_release_approval` | `forked` | `paddle` | `live` | `true` | `production` | `release_hash_mismatch` | `live` | `absent` | `checked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #1 |
| 2 | `C3_revenue_split` | `resolved_by_set` | `fungies` | `sandbox` | `false` | `production` | `active_rail` | `sandbox` | `valid` | `unchecked` | `us_territory` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #2 |
| 3 | `C1_data_accuracy` | `given` | `polar` | `gated` | `true` | `production` | `active_rail` | `live` | `invalid` | `unchecked` | `us` | 400 Bad Request (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #3 |
| 4 | `C3_revenue_split` | `refused` | `paddle` | `live` | `false` | `development` | `bare_slug_single` | `live` | `typo_suggested` | `unchecked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #4 |
| 5 | `C2_release_approval` | `given` | `paddle` | `sandbox` | `false` | `unset_node_prod` | `bare_slug_ambiguous` | `live` | `valid` | `checked` | `us` | 409 Conflict (product_slug_ambiguous) | billing_consent_checkout.pairwise.test.ts row #5 |
| 6 | `C1_data_accuracy` | `resolved_by_set` | `paddle` | `gated` | `true` | `unset_node_prod` | `bare_slug_single` | `live` | `invalid` | `checked` | `us_territory` | 400 Bad Request (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #6 |
| 7 | `C2_release_approval` | `refused` | `paddle` | `gated` | `true` | `unset_node_test` | `active_rail` | `sandbox` | `typo_suggested` | `checked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #7 |
| 8 | `C1_data_accuracy` | `forked` | `lemonsqueezy` | `live` | `false` | `production` | `active_rail` | `sandbox` | `absent` | `unchecked` | `us` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #8 |
| 9 | `C3_revenue_split` | `forked` | `paddle` | `sandbox` | `true` | `preview` | `bare_slug_ambiguous` | `live` | `invalid` | `unchecked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #9 |
| 10 | `C1_data_accuracy` | `refused` | `paddle` | `sandbox` | `true` | `production` | `bare_slug_single` | `live` | `typo_suggested` | `checked` | `us` | 400 Bad Request (product_ref_requires_handle) | billing_consent_checkout.pairwise.test.ts row #10 |
| 11 | `C3_revenue_split` | `given` | `fungies` | `gated` | `false` | `unset_node_test` | `active_rail` | `live` | `absent` | `unchecked` | `us` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #11 |
| 12 | `C2_release_approval` | `given` | `paddle` | `live` | `false` | `preview` | `no_rails` | `live` | `typo_suggested` | `checked` | `us_territory` | 404 Not Found | billing_consent_checkout.pairwise.test.ts row #12 |
| 13 | `C2_release_approval` | `resolved_by_set` | `paddle` | `live` | `true` | `production` | `bare_slug_ambiguous` | `live` | `absent` | `checked` | `us_territory` | 409 Conflict (product_slug_ambiguous) | billing_consent_checkout.pairwise.test.ts row #13 |
| 14 | `C1_data_accuracy` | `forked` | `polar` | `gated` | `true` | `preview` | `active_rail` | `sandbox` | `valid` | `checked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #14 |
| 15 | `C2_release_approval` | `resolved_by_set` | `creem` | `sandbox` | `true` | `preview` | `active_rail` | `sandbox` | `absent` | `unchecked` | `us` | 302 Found (redirect to rail with creem metadata) | billing_consent_checkout.pairwise.test.ts row #15 |
| 16 | `C3_revenue_split` | `forked` | `paddle` | `live` | `false` | `unset_node_test` | `bare_slug_single` | `live` | `valid` | `checked` | `us_territory` | 400 Bad Request (product_ref_requires_handle) | billing_consent_checkout.pairwise.test.ts row #16 |
| 17 | `C2_release_approval` | `refused` | `polar` | `live` | `false` | `unset_node_test` | `active_rail` | `sandbox` | `invalid` | `unchecked` | `us_territory` | 400 Bad Request (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #17 |
| 18 | `C3_revenue_split` | `refused` | `paddle` | `gated` | `false` | `preview` | `release_hash_mismatch` | `live` | `typo_suggested` | `unchecked` | `us_territory` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #18 |
| 19 | `C1_data_accuracy` | `resolved_by_set` | `polar` | `sandbox` | `true` | `development` | `active_rail` | `sandbox` | `absent` | `checked` | `us` | 404 Not Found | billing_consent_checkout.pairwise.test.ts row #19 |
| 20 | `C2_release_approval` | `refused` | `lemonsqueezy` | `gated` | `true` | `development` | `active_rail` | `live` | `valid` | `checked` | `us_territory` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #20 |
| 21 | `C3_revenue_split` | `forked` | `paddle` | `gated` | `true` | `development` | `no_rails` | `live` | `invalid` | `unchecked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #21 |
| 22 | `C2_release_approval` | `forked` | `fungies` | `live` | `true` | `preview` | `active_rail` | `sandbox` | `typo_suggested` | `checked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #22 |
| 23 | `C3_revenue_split` | `given` | `creem` | `live` | `false` | `unset_node_prod` | `active_rail` | `sandbox` | `typo_suggested` | `unchecked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #23 |
| 24 | `C1_data_accuracy` | `refused` | `creem` | `sandbox` | `false` | `unset_node_test` | `active_rail` | `live` | `valid` | `checked` | `us_territory` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #24 |
| 25 | `C1_data_accuracy` | `refused` | `paddle` | `sandbox` | `false` | `unset_node_prod` | `release_hash_mismatch` | `live` | `invalid` | `checked` | `us` | 400 Bad Request (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #25 |
| 26 | `C3_revenue_split` | `forked` | `polar` | `sandbox` | `false` | `unset_node_prod` | `active_rail` | `sandbox` | `absent` | `unchecked` | `us` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #26 |
| 27 | `C1_data_accuracy` | `resolved_by_set` | `paddle` | `gated` | `false` | `development` | `bare_slug_ambiguous` | `live` | `typo_suggested` | `unchecked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #27 |
| 28 | `C1_data_accuracy` | `refused` | `paddle` | `sandbox` | `true` | `unset_node_test` | `no_rails` | `live` | `absent` | `unchecked` | `us` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #28 |
| 29 | `C1_data_accuracy` | `refused` | `fungies` | `live` | `false` | `unset_node_prod` | `active_rail` | `sandbox` | `invalid` | `checked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #29 |
| 30 | `C3_revenue_split` | `resolved_by_set` | `lemonsqueezy` | `sandbox` | `true` | `unset_node_test` | `active_rail` | `sandbox` | `typo_suggested` | `unchecked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #30 |
| 31 | `C1_data_accuracy` | `given` | `paddle` | `gated` | `true` | `development` | `release_hash_mismatch` | `live` | `valid` | `checked` | `us` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #31 |
| 32 | `C2_release_approval` | `refused` | `paddle` | `gated` | `true` | `unset_node_test` | `bare_slug_ambiguous` | `live` | `invalid` | `unchecked` | `us_territory` | 400 Bad Request (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #32 |
| 33 | `C1_data_accuracy` | `forked` | `creem` | `gated` | `false` | `development` | `active_rail` | `live` | `invalid` | `unchecked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #33 |
| 34 | `C3_revenue_split` | `resolved_by_set` | `paddle` | `gated` | `false` | `unset_node_prod` | `no_rails` | `live` | `valid` | `unchecked` | `us` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #34 |
| 35 | `C3_revenue_split` | `refused` | `creem` | `sandbox` | `false` | `production` | `active_rail` | `sandbox` | `absent` | `unchecked` | `us_territory` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #35 |
| 36 | `C2_release_approval` | `given` | `lemonsqueezy` | `sandbox` | `true` | `unset_node_prod` | `active_rail` | `live` | `invalid` | `checked` | `us` | 400 Bad Request (buyer_email_invalid) | billing_consent_checkout.pairwise.test.ts row #36 |
| 37 | `C3_revenue_split` | `refused` | `paddle` | `gated` | `false` | `production` | `no_rails` | `live` | `typo_suggested` | `unchecked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #37 |
| 38 | `C2_release_approval` | `given` | `paddle` | `gated` | `false` | `preview` | `bare_slug_single` | `live` | `absent` | `checked` | `us` | 400 Bad Request (product_ref_requires_handle) | billing_consent_checkout.pairwise.test.ts row #38 |
| 39 | `C3_revenue_split` | `given` | `fungies` | `sandbox` | `false` | `development` | `active_rail` | `sandbox` | `absent` | `unchecked` | `us_territory` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #39 |
| 40 | `C2_release_approval` | `resolved_by_set` | `paddle` | `gated` | `false` | `unset_node_test` | `release_hash_mismatch` | `live` | `typo_suggested` | `checked` | `us` | 403 Forbidden | billing_consent_checkout.pairwise.test.ts row #40 |
| 41 | `C2_release_approval` | `forked` | `polar` | `sandbox` | `true` | `unset_node_prod` | `active_rail` | `live` | `typo_suggested` | `checked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #41 |
| 42 | `C3_revenue_split` | `refused` | `lemonsqueezy` | `sandbox` | `true` | `preview` | `active_rail` | `live` | `absent` | `checked` | `non_us` | 403 Forbidden (country_not_supported) | billing_consent_checkout.pairwise.test.ts row #42 |

## Explicit paths (outside the PICT rows)

Six named cases in the same test file, outside the PICT rows:

- resolved_by_set + paddle + live + production + live rail: 302 Found.
- resolved_by_set + paddle + sandbox + sandbox flag on + development + sandbox rail: 302 Found.
- given + paddle + sandbox without the sandbox flag + development + sandbox rail: 403 Forbidden.
- given + paddle + live + sandbox flag on + preview + sandbox rail (rail mode mismatch): 500 Internal Server Error.
- given + paddle + sandbox + sandbox flag on + development + live rail (rail mode mismatch): 500 Internal Server Error.
- given + creem + live + production + live rail with buyer consent checked: 302 Found, consent carried as creem metadata.

**Why these exist.** No generated row reaches the 500 rail-mode mismatch. Masking gates (refused heads, gated launch, bare slugs) hide it in every row, and the outcome distribution above shows it. Pairwise coverage counts pairs, not reachable outcomes, so the mismatch and the creem metadata path are asserted explicitly.
