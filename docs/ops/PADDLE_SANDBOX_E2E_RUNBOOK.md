# Paddle Sandbox Option A E2E Runbook

**Owner:** ExpanPress ops · **Branch:** `test/paddle-sandbox-e2e` · **Scope:** Local / CI sandbox verification only. Never run against production `expanpress.com` or with `PADDLE_API_KEY` (`pdl_live_*`).

## 1. Purpose

I use this runbook to provision the sample book in Paddle sandbox and run the Playwright Option A checkout, thank-you copy, signed webhook, and PDF delivery test (`web/e2e/paddle-sandbox-overlay.spec.ts`) without touching production Supabase, Resend, Dub, Upstash, or live Paddle.

## 2. Preconditions and Safety Rules

1. **Sandbox credentials only:** Read only `PADDLE_SANDBOX_API_KEY` (`pdl_sdbx_*`) and fetch an active `test_*` client token from `https://sandbox-api.paddle.com/client-tokens?status=active`. Never load the full `.env` file and never print any credential.
2. **Fail-closed guards:**
   - `scripts/paddle_sandbox_sample_product.ts` refuses `pdl_live_*` keys, non-`pdl_sdbx_*` keys, any base URL other than `https://sandbox-api.paddle.com`, and `PADDLE_ENVIRONMENT=production`, `VERCEL_ENV=production`, or `NODE_ENV=production`.
   - `web/playwright.config.ts` refuses `live_*` client tokens and `pdl_live_*` API keys when `E2E_PADDLE_SANDBOX=1`.
   - `web/e2e/paddle-sandbox-overlay.spec.ts` aborts requests to `https://api.paddle.com/**` and `https://checkout.paddle.com/**`, and intercepts `https://expanpress.com/books/**` locally via `APP_URL`.
3. **Registry sandbox opt-in (gitignored):** `DEFAULT_GLOBAL.payments.sandbox_checkout_enabled` stays `false` in code. For a sandbox E2E run, write a temporary gitignored `data/settings/global.json` in the worktree root with `{"payments":{"sandbox_checkout_enabled":true}}`, then delete `data/` when finished.

## 3. Step 1 — Provision or Verify the Sandbox Product and Price

Run a dry run first (zero network calls):

```bash
pnpm exec tsx scripts/paddle_sandbox_sample_product.ts --dry-run
```

Then run against Paddle sandbox, passing **only** `PADDLE_SANDBOX_API_KEY` in the subshell environment:

```bash
python3 -c '
import os, subprocess
val = next(
    line.split("=", 1)[1].strip().strip("\"").strip("\x27")
    for line in open(".env", encoding="utf-8")
    if line.strip().startswith("PADDLE_SANDBOX_API_KEY=")
)
env = os.environ.copy()
env["PADDLE_SANDBOX_API_KEY"] = val
raise SystemExit(subprocess.run(["pnpm", "exec", "tsx", "scripts/paddle_sandbox_sample_product.ts"], env=env).returncode)
'
```

Expected result:
- `GET /products` (`200 OK`) checks for an existing `house_sample_the_quiet_workshop_v1` product.
- If absent, `POST /products` returns `201 Created` (`tax_category` starts at `GLOBAL.payments.paddle.product_tax_category`; if Paddle returns `400 Bad Request` with `product_tax_category_not_approved`, the script tries `GLOBAL.payments.paddle.sandbox_tax_category_fallbacks`).
- `POST /prices` returns `201 Created` (or reuses the existing `$9.00 USD` one-time price).
- Readbacks `GET /products/<pro_id>` and `GET /prices/<pri_id>` return `200 OK`.

## 4. Step 2 — Run the Hermetic Offline Playwright Suite

With `E2E_PADDLE_SANDBOX` unset, `web/e2e/paddle-sandbox-overlay.spec.ts` skips cleanly and all offline specs run against `web/e2e/mock-supabase.ts`:

```bash
E2E_MOCK_PORT=54429 E2E_FIRMA_TLS_PORT=54430 E2E_APP_PORT=3111 pnpm --dir web test:e2e
```

## 5. Step 3 — Run the Live Sandbox Option A E2E Spec

Use isolated ports if another worktree owns `3100`/`54399`/`54400`:

1. Fetch the active `test_*` client token in memory from `https://sandbox-api.paddle.com/client-tokens?status=active`.
2. Write `data/settings/global.json` (`{"payments":{"sandbox_checkout_enabled":true}}`).
3. Run:
   `E2E_PADDLE_SANDBOX=1` `E2E_PADDLE_SANDBOX_PRICE_ID=<pri_id>` `E2E_MOCK_PORT=54419` `E2E_FIRMA_TLS_PORT=54420` `E2E_APP_PORT=3110` `pnpm --dir web exec playwright test e2e/paddle-sandbox-overlay.spec.ts`.
4. Remove `data/` immediately in a `finally` block so the worktree stays clean.

### What the Spec Asserts

1. `GET /checkout/<sandboxSampleProductId>` returns `200 OK` and displays `"The Quiet Workshop (Sample)"`, `"$9.00"`, `"USD · one-time"`, `"Merchant of Record"`, and the `2 minutes` / `1 hour` / `support@expanpress.com` consent text.
2. Submitting `BuyerEmailStep` sends `POST /api/billing/checkout` and receives `200 OK` `{ ok: true, kind: "paddle_overlay", payload }`.
3. Paddle.js opens the sandbox overlay iframe; the spec completes payment using Paddle's published test card (`4242 4242 4242 4242`, `12/35`, `100`, `"Test Buyer"`, US ZIP `10021`).
4. `successUrl` (`https://expanpress.com/books/expanpress_house/thanks`) is intercepted locally and asserts the thank-you heading, delivery promise copy, and back link.
5. The real `txn_*` transaction is fetched from `sandbox-api.paddle.com`, signed with `Paddle-Signature`, and posted to `/api/billing/webhook`, returning `200 OK` `{ ok: true }`.
6. `/__deliveries` confirms the `orders` row (`buyer_email_consent: true`, `amount_usd` matching total cents), 1 captured local Resend email (no outbound send), and 1 captured Dub target URL (`/books/d/<token>`).
7. `HEAD /books/d/<token>` returns `200 OK`; `GET /books/d/<token>` returns `302 Found` to the signed PDF URL; fetching that URL returns `200 OK` (`application/pdf`, `%PDF-`), and `download_events` logs `link_issued` followed by `download_completed`.
