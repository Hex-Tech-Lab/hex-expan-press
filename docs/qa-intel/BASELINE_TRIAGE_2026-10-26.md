# QA-Intel and contract-auditor baseline triage, 2026-10-26

Scope: the first baseline written after porting the engine (`scripts/qa-intel/engine/`) and the contract auditor to hex-expan.
Source: `.qa-intel/baseline.json` (290 entries, 18 high) and `scripts/contract-auditor.baseline.json` (1 critical).
Verdict key: ACCEPTED = a real finding we are choosing not to fix now, with the reason. FALSE-POSITIVE = the rule is wrong for this case. OPEN = real and not yet fixed; tracked as debt in CLAUDE.md.

## High findings (qa-intel)

| File | Finding | Verdict | Reason / next step |
|---|---|---|---|
| web/src/components/storefront/buy-link.tsx (x2) | Empty catch swallows error | ACCEPTED | Already accepted in the committed baseline (b825899). Owner: web. Fix: log the error. |
| web/app/api/billing/webhook/handler.ts (x2) | DB operation without validation | OPEN | Billing path. Needs a focused review before any change. Tracked in CLAUDE.md debt. |
| web/app/api/billing/webhook/handler.ts | Timeout abort does not settle error state | OPEN | Same file as the webhook debt in CLAUDE.md. |
| web/app/api/esign/webhook/route.ts | Timeout abort does not settle error state | OPEN | E-sign webhook. Review with the webhook debt. |
| web/app/creator/review/review-client.tsx | d3/canvas effect missing data dependency | OPEN | Needs a look at the effect's dependency list. Low blast radius. |
| web/playwright.config.ts, web/e2e/constants.ts | localhost fallback in production route | ACCEPTED | Test and e2e configuration only. Not a production route. |
| supabase/migrations/20261009000000_launch_trigger_and_audit.sql | advisory-lock gate lacks isolation guard (enforce_launch_gate) | FALSE-POSITIVE | The latest definition is in 20261011000000, which adds the READ COMMITTED guard (line 31). Rule should check the latest definition (open debt). |
| supabase/migrations/20261004000900_submit_consent_race_lock.sql | advisory-lock gate lacks isolation guard (submit_consent) | ACCEPTED, cleared by PR | Real on master today. The C3 branch (`fix/c3-given-evidence-required`, commit 313a6aa) adds the guard, so this clears when that merges. |
| supabase/migrations/20260927000100, 20260929000000, 20261001000000, 20261002000000, 20261004000200, 20261004000300, 20261004000900 | SECURITY DEFINER exposes a caller-controlled parameter | ACCEPTED (heuristic) | Historical definitions of submit_consent. Each one checks ownership in the body (creator membership, signer identity). The rule is a heuristic and is over-broad here. Open debt: tune the rule. |

## contract-auditor

| Rule | File | Verdict | Reason |
|---|---|---|---|
| SILENT_SUCCESS_ON_MISSING_CONFIG (critical) | scripts/qa-intel/engine/calibration/run-smellycode-calibration.ts:40 | ACCEPTED | The SmellyCode dataset is optional and local-only. A missing dataset is an intended skip. Recorded in `scripts/contract-auditor.baseline.json`. |
| 45 warnings | various | Not gated | Warnings are informational. Several are real silent-error returns (for example payments/src/providers/payhip.ts:97) and are open debt. |

## Not in this port

- `scripts/strict-merge.sh` and its test: on `chore/contract-auditor-gate` (`hex-expan-wt-gate`). Land separately.
- `scripts/qa-intel/engine/rules/__tests__/strict-merge.test.ts`: removed from the port because it tests the script above.

## Test status at this baseline

- `vitest run scripts/qa-intel`: 245 passed, 6 skipped (the settings-manifest cases, skipped with a reason).
- Root `tsc --noEmit`: exit 0.
- `qa-intel --mode full --compare`: no new issues against the baseline.
- `contract-auditor`: 0 new criticals against the baseline.
