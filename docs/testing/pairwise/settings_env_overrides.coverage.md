# Pairwise Coverage: Settings Env Overrides (SANDBOX_CHECKOUT_ENABLED x global.json x VERCEL_ENV)

- **Branch:** `fix/email-streams-registry`
- **Model:** `docs/testing/pairwise/settings_env_overrides.model.txt`
- **Generated rows:** `docs/testing/pairwise/settings_env_overrides.rows.tsv` (**16 rows**, order 2, 3 factors)
- **PICT binary:** `/usr/local/bin/pict`
- **Pairwise coverage:** **40 / 40 pairs (100.0%)** — 0 uncovered pairs
- **Asserted by:** `payments/test/settings_env_overrides.pairwise.test.ts` (17 tests: 1 drift check + 16 per-row assertions)

## Factors

- `sandbox_checkout_env`: `unset`, `true` (`"true"`), `false` (`"false"`), `yes` (`"yes"`, invalid and ignored)
- `file_value`: `true`, `false`, `absent` (`payments.sandbox_checkout_enabled` in `data/settings/global.json`)
- `vercel_env`: `unset`, `preview`, `production`, `preview_padded` (`" preview "`, trimmed by `deployVercelEnv`)

## Row mapping

| # | sandbox_checkout_env | file_value | vercel_env | Expected `sandbox_checkout_enabled` | Expected `isNonProductionRuntime()` | Asserted by |
|---:|---|---|---|---|---|---|
| 1 | `yes` | `absent` | `preview` | `false` | `true` | settings_env_overrides.pairwise.test.ts row #1 |
| 2 | `yes` | `true` | `production` | `true` | `false` | settings_env_overrides.pairwise.test.ts row #2 |
| 3 | `yes` | `false` | `unset` | `false` | `true` | settings_env_overrides.pairwise.test.ts row #3 |
| 4 | `yes` | `absent` | `preview_padded` | `false` | `true` | settings_env_overrides.pairwise.test.ts row #4 |
| 5 | `true` | `absent` | `unset` | `true` | `true` | settings_env_overrides.pairwise.test.ts row #5 |
| 6 | `false` | `absent` | `production` | `false` | `false` | settings_env_overrides.pairwise.test.ts row #6 |
| 7 | `false` | `true` | `preview_padded` | `false` | `true` | settings_env_overrides.pairwise.test.ts row #7 |
| 8 | `false` | `false` | `preview` | `false` | `true` | settings_env_overrides.pairwise.test.ts row #8 |
| 9 | `unset` | `false` | `production` | `false` | `false` | settings_env_overrides.pairwise.test.ts row #9 |
| 10 | `false` | `true` | `unset` | `false` | `true` | settings_env_overrides.pairwise.test.ts row #10 |
| 11 | `unset` | `false` | `preview_padded` | `false` | `true` | settings_env_overrides.pairwise.test.ts row #11 |
| 12 | `true` | `true` | `production` | `true` | `false` | settings_env_overrides.pairwise.test.ts row #12 |
| 13 | `unset` | `true` | `preview` | `true` | `true` | settings_env_overrides.pairwise.test.ts row #13 |
| 14 | `true` | `false` | `preview_padded` | `true` | `true` | settings_env_overrides.pairwise.test.ts row #14 |
| 15 | `unset` | `absent` | `unset` | `false` | `true` | settings_env_overrides.pairwise.test.ts row #15 |
| 16 | `true` | `absent` | `preview` | `true` | `true` | settings_env_overrides.pairwise.test.ts row #16 |

## Uncovered combinations note

- Pairwise (order 2) pair coverage is **100.0% (40/40 pairs)**; no pair was omitted.
