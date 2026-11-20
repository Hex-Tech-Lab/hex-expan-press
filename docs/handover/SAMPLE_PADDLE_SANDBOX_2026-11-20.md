# Sample Listing: Paddle Sandbox Provisioning & Option A E2E Handover (2026-11-20)

**Task:** `sample-paddle-sandbox` · **Agent:** `agy-hydrogen` · **Worktree:** `../hex-expan-e2e` · **Branch:** `test/paddle-sandbox-e2e` (from `origin/fix/funnel-kyc-buildable` at `0d6ffc8`) · **Scope:** Paddle sandbox only. Zero production records, zero production runs, zero outbound emails, zero KYC submissions, zero deploys, zero merges.

## 0. Status

- **GREEN:** `scripts/paddle_sandbox_sample_product.ts` built against the book identity SSOT (`books/sample_the_quiet_workshop.json`) and `payments/src/settings_registry.ts`, executed against Paddle sandbox (`https://sandbox-api.paddle.com`), and verified idempotently (`200 OK` readbacks on product and price).
- **GREEN:** Fixed a HIGH finding in `web/app/checkout/[productId]/page.tsx` where `checkout_mode === "sandbox"` failed to open `BuyerEmailStep` and pass `paddleClient` even when `sandboxAllowed()` was true.
- **GREEN:** End-to-end Playwright test (`web/e2e/paddle-sandbox-overlay.spec.ts`) drove one real `$9.00` USD sandbox purchase through the Paddle.js Option A overlay using Paddle's published test card, intercepted `successUrl` locally on `APP_URL`, verified thank-you copy, signed and posted `transaction.completed` to `/api/billing/webhook` (`200 OK`), and verified local Resend + Dub capture plus `HEAD` (`200 OK`) and `GET` (`302 Found` to `%PDF-`) delivery.
- **YELLOW (Founder action):** Paddle sandbox rejected `tax_category: "ebooks"` and `"digital-goods"` with `400 Bad Request` (`product_tax_category_not_approved`), so the sandbox product was created under `"standard"`. Confirm Paddle approves `"ebooks"` on both sandbox and live accounts before Step 10 of `SAMPLE_LISTING_EXEC_PLAN_2026-11-19.md`.

## 1. Recorded Sandbox Identifiers

I ran `scripts/paddle_sandbox_sample_product.ts` reading only `PADDLE_SANDBOX_API_KEY` from `.env` (never loading the full `.env` and never printing any secret value):

| Item | Value / Result | Evidence / Notes |
|---|---|---|
| Sandbox API base | `https://sandbox-api.paddle.com` | From `GLOBAL.payments.paddle.api_base.sandbox` |
| Book SSOT | `books/sample_the_quiet_workshop.json` | Title `"The Quiet Workshop (Sample)"`, slug `sample_the_quiet_workshop`, subtitle `"Twelve Practical Projects for a Small Home Bench"`, `store_product_id` `house_sample_the_quiet_workshop_v1` |
| Product ID | `pro_01m7v59btzws20t4ddn5cc4hzm` | `201 Created`, verified `200 OK` via `GET /products/pro_01m7v59btzws20t4ddn5cc4hzm` |
| Price ID | `pri_01m7v59c64k3v2m8146wmn05qp` | `201 Created` (`"900"` minor units = `$9.00 USD`, `billing_cycle: null`), verified `200 OK` via `GET /prices/pri_01m7v59c64k3v2m8146wmn05qp` |
| Requested `tax_category` | `ebooks` (from `GLOBAL.payments.paddle.product_tax_category`) | Returned `400 Bad Request` (`product_tax_category_not_approved`); fallback `"digital-goods"` also returned `400 Bad Request` (`product_tax_category_not_approved`) |
| Applied sandbox `tax_category` | `standard` | Returned `201 Created`; matches existing sandbox product `pro_01m69a1tjz9kgwwz1879776y9x` |
| Active sandbox client token | `ctkn_01m69a22v2tgmeaz2dsys4ne52` (`expan-sandbox-test-2`) | Active `test_*` token fetched in memory during E2E run; never written to disk |
| E2E sandbox transactions | `txn_01m7v5ga58bq3586pxgem8wbve`, `txn_01m7v5nmj37ag2g45gg97v8nvf` | Both `status: completed`, `total: "980"` cents USD (`$9.00` + `$0.80` US tax for ZIP `10021`), `custom_data: {"order_ref": "e2e_sandbox", "buyer_consent": "true"}` |

## 2. Changes on `test/paddle-sandbox-e2e`

1. **`payments/src/settings_registry.ts` + `payments/test/settings_registry_runtime.test.ts`**: Added `payments.paddle.product_tax_category` (`"ebooks"`), `payments.paddle.sandbox_api_key_env` (`"PADDLE_SANDBOX_API_KEY"`), and `payments.paddle.sandbox_tax_category_fallbacks` (`["digital-goods", "standard"]`).
2. **`books/sample_the_quiet_workshop.json` + `payments/book_identity.ts`**: Added optional `description`, `product_slug`, `store_product_id`, and `price` (`{ usd: 9.0, currency: "USD" }`) fields to the SSOT schema and sample book registry so no price or store id literal lives in scripts.
3. **`scripts/paddle_sandbox_sample_product.ts` + `payments/test/paddle_sandbox_sample_product.test.ts`**: Sandbox-only product and one-time price provisioner. Refuses any `pdl_live_*` key, non-`pdl_sdbx_*` key, non-`sandbox-api.paddle.com` base URL, or `production` env flag. Idempotent across re-runs.
4. **`web/app/checkout/[productId]/page.tsx` + `__tests__/page.test.ts` (HIGH fix)**: Allowed `checkout_mode === "sandbox"` to render `BuyerEmailStep` and pass `paddleClient` when `sandboxAllowed()` is true, matching `web/app/api/billing/checkout/route.ts` and `paddleOverlayUsable()`.
5. **`payments/src/delivery.ts`**: Added non-production loopback-only `DUB_API_BASE_URL` guard in `createDubShortLink` (`localhost` / `127.0.0.1` only; production remains pinned to `https://api.dub.co`).
6. **`web/e2e/` (`constants.ts`, `mock-supabase.ts`, `playwright.config.ts`, `paddle-sandbox-overlay.spec.ts`)**: Added isolated port env overrides (`E2E_MOCK_PORT`, `E2E_FIRMA_TLS_PORT`, `E2E_APP_PORT`), local PostgREST/Redis/Dub/Resend mocks in `mock-supabase.ts`, and the Option A sandbox Playwright spec (`paddle-sandbox-overlay.spec.ts`).

## 3. Deferred MEDIUM Findings

- **Registry alignment with `feat/quiet-workshop-listing` (MEDIUM, deferred):** I added `store_product_id` and `price` to `books/sample_the_quiet_workshop.json` on `test/paddle-sandbox-e2e`, while `feat/quiet-workshop-listing` holds the earlier `price` block plus `creator` and `release` metadata. Reconcile both JSON blocks when merging PRs.
- **Sandbox tax category approval gap (MEDIUM, deferred):** Paddle sandbox currently approves `"standard"` rather than `"ebooks"` or `"digital-goods"`. I kept `"ebooks"` as the SSOT default in `payments/src/settings_registry.ts` and recorded the `400 Bad Request` responses here for follow-up with Paddle support.
- **`next.config.ts` ESLint deprecation warning (MEDIUM, deferred):** Next.js 16 logs `Unrecognized key(s) in object: 'eslint'` during startup; pre-existing and out of scope.

## 4. Verification Run

- `pnpm --dir ../hex-expan-e2e exec tsc --noEmit` -> exit 0.
- `pnpm --dir ../hex-expan-e2e/web type-check && pnpm --dir ../hex-expan-e2e/web e2e:type-check && pnpm --dir ../hex-expan-e2e/web lint` -> exit 0 (0 errors, 6 pre-existing warnings).
- `pnpm --dir ../hex-expan-e2e exec vitest run payments/test/ web/app/api/billing/checkout/ web/app/checkout/ web/src/lib/__tests__/paddle-overlay.test.ts` -> 52 files, 880 passed, 1 skipped.
- Sandbox Playwright run (`E2E_PADDLE_SANDBOX=1` on isolated ports `3114`/`54459`/`54460`) -> `1 passed (32.1s)` (`web/e2e/paddle-sandbox-overlay.spec.ts`).
- Offline Playwright specs (`a11y.spec.ts` + `b2c-confinement.spec.ts`: 14 passed, 1 expected `PAY_HOST_LIVE` skip; `book-preview.spec.ts` + `creator_funnel.spec.ts` + `focus.spec.ts` + `paddle-sandbox-overlay.spec.ts` offline: 7 passed, 1 expected sandbox skip).
