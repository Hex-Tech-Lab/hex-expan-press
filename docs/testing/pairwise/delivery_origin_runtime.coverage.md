# Pairwise Coverage: Delivery Origin Runtime Override (DELIVERY_DOWNLOAD_ORIGIN x VERCEL_ENV x global.json)

- **Branch:** `fix/email-streams-registry`
- **Model:** `docs/testing/pairwise/delivery_origin_runtime.model.txt`
- **Generated rows:** `docs/testing/pairwise/delivery_origin_runtime.rows.tsv` (**16 rows**, order 2, 3 factors)
- **PICT binary:** `/usr/local/bin/pict`
- **Pairwise coverage:** **32 / 32 pairs (100.0%)** — 0 uncovered pairs
- **Asserted by:** `payments/test/delivery_origin_runtime.pairwise.test.ts` (17 tests: 1 drift check + 16 per-row assertions)

## Factors

- `delivery_download_origin`: `unset`, `branch_alias` (`https://hex-expan-press-git-fix-email-strea-b16b58-techhypexps-projects.vercel.app`), `production_apex` (`https://expanpress.com`), `non_allowed_host` (`https://evil.example.com`)
- `vercel_env`: `unset`, `preview`, `production`, `development` (`NODE_ENV` pinned to `"test"` in harness)
- `global_json`: `present` (`data/settings/global.json` sets `delivery.download_origin = "https://mail.expanpress.com"`), `absent`

## Row mapping

| # | delivery_download_origin | vercel_env | global_json | `downloadOriginOverride()` | `loadDeliverySection` / `GLOBAL.delivery.download_origin` | Asserted by |
|---:|---|---|---|---|---|---|
| 1 | `production_apex` | `preview` | `present` | `null` | Throws refused-on-non-production error | delivery_origin_runtime.pairwise.test.ts row #1 |
| 2 | `branch_alias` | `production` | `present` | `null` | `"https://mail.expanpress.com"` (file) | delivery_origin_runtime.pairwise.test.ts row #2 |
| 3 | `production_apex` | `unset` | `absent` | `null` | Throws refused-on-non-production error | delivery_origin_runtime.pairwise.test.ts row #3 |
| 4 | `production_apex` | `production` | `absent` | `null` | `"https://expanpress.com"` (default) | delivery_origin_runtime.pairwise.test.ts row #4 |
| 5 | `non_allowed_host` | `production` | `absent` | `null` | `"https://expanpress.com"` (default) | delivery_origin_runtime.pairwise.test.ts row #5 |
| 6 | `unset` | `development` | `absent` | `null` | `"https://expanpress.com"` (default) | delivery_origin_runtime.pairwise.test.ts row #6 |
| 7 | `unset` | `production` | `present` | `null` | `"https://mail.expanpress.com"` (file) | delivery_origin_runtime.pairwise.test.ts row #7 |
| 8 | `production_apex` | `development` | `present` | `null` | Throws refused-on-non-production error | delivery_origin_runtime.pairwise.test.ts row #8 |
| 9 | `unset` | `preview` | `absent` | `null` | `"https://expanpress.com"` (default) | delivery_origin_runtime.pairwise.test.ts row #9 |
| 10 | `branch_alias` | `development` | `absent` | `branch_alias` | `branch_alias` | delivery_origin_runtime.pairwise.test.ts row #10 |
| 11 | `non_allowed_host` | `unset` | `present` | `null` | Throws refused-on-non-production error | delivery_origin_runtime.pairwise.test.ts row #11 |
| 12 | `non_allowed_host` | `preview` | `present` | `null` | Throws refused-on-non-production error | delivery_origin_runtime.pairwise.test.ts row #12 |
| 13 | `branch_alias` | `preview` | `absent` | `branch_alias` | `branch_alias` | delivery_origin_runtime.pairwise.test.ts row #13 |
| 14 | `unset` | `unset` | `absent` | `null` | `"https://expanpress.com"` (default) | delivery_origin_runtime.pairwise.test.ts row #14 |
| 15 | `branch_alias` | `unset` | `present` | `branch_alias` | `branch_alias` | delivery_origin_runtime.pairwise.test.ts row #15 |
| 16 | `non_allowed_host` | `development` | `present` | `null` | Throws refused-on-non-production error | delivery_origin_runtime.pairwise.test.ts row #16 |

## Uncovered combinations note

- Pairwise (order 2) pair coverage is **100.0% (32/32 pairs)**; no pair was omitted.
- `vercel_env = unset` with `NODE_ENV = "production"` (non-Vercel production build) is outside the 3-factor model and covered explicitly in `payments/test/download_origin_override.test.ts`.
