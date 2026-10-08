# Sprint 18 Backlog — P1

## Paddle checkout attribution (custom_data)

**Priority:** P1

**Context (facts):**
- Since Sprint 17 (PR #93) the storefront captures `?src` and `?dub_id` and the checkout route appends `reference_id=<src>[:<dub_id>]` to the provider redirect ONLY for Polar rails (`REFERENCE_ID_PROVIDERS` in `web/app/api/billing/checkout/route.ts`). Polar's webhook reads it back from `metadata.reference_id` (`payments/src/providers/polar.ts`).
- Paddle is excluded: its webhook reads attribution from `custom_data.attribution_id` (`payments/src/providers/paddle.ts`), and `custom_data` cannot be set by a URL query parameter on a checkout link. It must be injected when the checkout is created (Paddle API transaction/checkout creation, or the Paddle.js overlay `customData` option).
- Effect today: Paddle sales carry no src/dub_id attribution.

**Acceptance criteria:**
1. A Paddle checkout started from a storefront URL with `?src=x&dub_id=y` produces a webhook with `custom_data.attribution_id = "x:y"`.
2. Unsafe values are dropped using the same `ATTRIBUTION_RE` validation as the route.
3. A hermetic test covers it.
4. No live keys in tests.

**Open questions:**
- API-created transaction vs overlay.
- Where the dub_id click is recorded for dub.co lead tracking.
