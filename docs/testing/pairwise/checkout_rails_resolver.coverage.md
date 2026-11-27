# Pairwise Coverage: Checkout Rails Resolver (rev 2)

- **Branch:** `fix/email-streams-registry`
- **Model:** `docs/testing/pairwise/checkout_rails_resolver.model.txt`
- **Seed:** `docs/testing/pairwise/checkout_rails_resolver.seed.tsv`
- **Generated rows:** `docs/testing/pairwise/checkout_rails_resolver.rows.tsv` (**15 rows**, order 2, 5 factors)
- **PICT binary:** `/usr/local/bin/pict`
- **Pairwise coverage:** **75 / 75 pairs (100.0%)** — 0 uncovered pairs
- **Asserted by:** `web/__tests__/checkout_rails_resolver.pairwise.test.ts` (20 tests: 1 drift check + 4 factor/seed/sandbox invariants + 15 per-row assertions)

## Factors updated in rev 2

- Added `sandboxAllowed` (`true`, `false`) alongside `checkout_mode` (`live`, `gated`, `sandbox`, `paddle`, `null`), `rails` (`zero`, `one`, `two`), `provider` (`paddle`, `creem`), and `price` (`set`, `null`).
- Rule asserted per row: `checkout_mode = sandbox` is purchasable only when `sandboxAllowed = true`, `price = set`, and `rails != zero` (and names `merchantOfRecordProvider` only when `rails = one`).

## Row mapping

| # | rails | provider | price | checkout_mode | sandboxAllowed | Expected purchasable | Expected MoR | Asserted by |
|---:|---|---|---|---|---|---|---|---|
| 1 | `one` | `creem` | `set` | `live` | `true` | `true` | `creem` | checkout_rails_resolver.pairwise.test.ts row #1 (seed) |
| 2 | `zero` | `paddle` | `null` | `sandbox` | `false` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #2 |
| 3 | `one` | `paddle` | `set` | `gated` | `false` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #3 |
| 4 | `one` | `creem` | `null` | `paddle` | `true` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #4 |
| 5 | `one` | `creem` | `set` | `sandbox` | `true` | `true` | `creem` | checkout_rails_resolver.pairwise.test.ts row #5 |
| 6 | `two` | `paddle` | `set` | `paddle` | `false` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #6 |
| 7 | `zero` | `creem` | `set` | `null` | `true` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #7 |
| 8 | `two` | `creem` | `null` | `gated` | `true` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #8 |
| 9 | `two` | `creem` | `set` | `sandbox` | `false` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #9 |
| 10 | `one` | `paddle` | `null` | `null` | `false` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #10 |
| 11 | `two` | `paddle` | `null` | `null` | `true` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #11 |
| 12 | `zero` | `paddle` | `null` | `gated` | `false` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #12 |
| 13 | `two` | `paddle` | `null` | `live` | `false` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #13 |
| 14 | `zero` | `paddle` | `set` | `paddle` | `true` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #14 |
| 15 | `zero` | `paddle` | `null` | `live` | `false` | `false` | `null` | checkout_rails_resolver.pairwise.test.ts row #15 |

## Uncovered combinations note

- Pairwise (order 2) pair coverage is **100.0% (75/75 pairs)**; no pair was omitted.
- Higher-order (3-way+) combinations such as `rails = two` + `checkout_mode = live` + `price = set` (POST fallback without a single MoR) are not forced by order-2 generation alone and are covered explicitly in `web/app/api/billing/checkout/__tests__/rails_page_route_agreement.pairwise.test.ts`.
