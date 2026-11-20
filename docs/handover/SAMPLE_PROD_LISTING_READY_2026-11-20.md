# Sample Production Listing Prep: Ready for Operator Execution (2026-11-20)

**Task:** `sample-prod-listing-prep` · **Agent:** `agy-hydrogen` · **Worktree:** `/home/kellyb_dev/projects/hex-expan-funnel` · **Branch:** `fix/funnel-kyc-buildable` (PR #138) · **Status:** PREPARE ONLY. Zero production DB writes, zero production storage uploads, zero `.env` loads, zero KYC submissions, zero outbound emails, zero deploys, and zero merges.

## 0. Status Summary

- **GREEN (`supabase/manual/sample_listing_prod.sql`):** Single idempotent transaction (`BEGIN; ... COMMIT;`) ending with read-only `SELECT` checks, validated in-process against real migrations in PGlite (`payments/test/sample_listing_prod_sql.test.ts`, 2/2 passed across clean + repeated idempotent run + non-operator guard).
- **GREEN (`scripts/upload_sample_release.ts`):** Registry-driven uploader targeting `GLOBAL.delivery.bucket` (`release-files`) and `books/sample_the_quiet_workshop.json`, verifying byte length (`501,698` bytes) and SHA-256 (`74751711467a13e89b98d10a4e5e490d82fc11c2463f37f5d77f4ab320b635d9`) before and after upload, supporting `--dry-run`, and naming every HTTP status code with its meaning (`payments/test/upload_sample_release.test.ts`, 6/6 passed; `--dry-run` verified against the real 501,698-byte PDF).
- **GREEN (Storefront non-live audit):** Verified by reading `web/app/books/page.tsx`, `web/app/books/[handle]/page.tsx`, `web/app/books/[handle]/[product]/page.tsx`, `web/src/components/storefront/storefront.tsx`, and `web/src/lib/book-assets.ts`. `/books` and `/books/[handle]` hide non-live products; `/books/expanpress_house/sample_the_quiet_workshop` renders `200 OK` with `NOINDEX`, non-buyable `Coming soon` badge, cover image, and working `<BookPreviewer>`.
- **YELLOW (Blocked on operator execution & Paddle live approval):** Production `creators`, `products`, `house_release_pins`, and `release-files` storage remain untouched. `checkout_mode` stays `'gated'` until Paddle live KYC approval (B3).

## 1. Deliverable 1: `supabase/manual/sample_listing_prod.sql`

I wrote `supabase/manual/sample_listing_prod.sql` as a single `BEGIN; ... COMMIT;` transaction followed by read-only `SELECT` verification queries:

1. **Operator-only execution:** Migrations `20261119120000_orders_buyer_email_consent.sql` and `20261119130000_house_title_exemption.sql` are applied in production. Trigger `creators_is_house_guard` blocks any role outside `('postgres', 'service_role', 'supabase_admin')`, and `public.house_release_pins` revokes all privileges from `public`, `anon`, and `authenticated` (`SELECT` only for `service_role`). Therefore, this SQL runs through the operator role (`postgres` / `supabase_admin` in Supabase SQL Editor or `psql`).
2. **House creator (`public.creators`):** Inserts or updates `handle = 'expanpress_house'`, `id = '295e2c6c-66b8-4fa0-9822-c0a044688273'`, `display_name = 'ExpanPress'`, `is_house = true` via `ON CONFLICT (handle) DO UPDATE`.
3. **Sample product (`public.products`):** Inserts or updates `id = '9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc'`, `slug = 'sample_the_quiet_workshop'`, `title = 'The Quiet Workshop (Sample)'`, `price_usd = 9.00`, `currency = 'USD'`, `store_product_id = 'house_sample_the_quiet_workshop_v1'`, `pdf_file = 'ExpanPress_Sample_TheQuietWorkshop_EliasHartwell_2026.pdf'`, `release_path = 'release/9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc_release.pdf'`, `release_sha256 = '74751711467a13e89b98d10a4e5e490d82fc11c2463f37f5d77f4ab320b635d9'`, `release_state = 'release'`, `release_year = 2026`, `checkout_mode = 'gated'`, and `book_registry = 'books/sample_the_quiet_workshop.json'` via `ON CONFLICT (creator_id, slug) DO UPDATE`.
4. **Why `checkout_mode = 'gated'`:** `products_checkout_mode_check` permits `('gated', 'live', 'sandbox', 'paddle')` (`'draft'` is not a valid database value). `'gated'` is the non-live draft state in `SAMPLE_LISTING_EXEC_PLAN_2026-11-19.md`, and unlike `'sandbox'`, `'gated'` stays non-buyable across every runtime regardless of `sandboxAllowed()`.
5. **House pin (`public.house_release_pins`):** Upserts `(product_id, sha256)` via `ON CONFLICT (product_id) DO UPDATE`, binding `sha256 = '74751711467a13e89b98d10a4e5e490d82fc11c2463f37f5d77f4ab320b635d9'`.
6. **Trailing `SELECT` checks:** Verifies the joined `creators` + `products` + `house_release_pins` row (`hash_matches_pin = true`) and evaluates `public.launch_block_reason(p.id, p.creator_id, p.release_sha256)`, which returns `NULL` (confirming the house-title launch gate is ready as soon as Paddle live approval clears and `checkout_mode` flips to `'live'`).

## 2. Deliverable 2: `scripts/upload_sample_release.ts` and Book SSOT Alignment

I updated `books/sample_the_quiet_workshop.json` and `payments/book_identity.ts` so the sample book SSOT carries `product_id`, `store_product_id`, `price`, `release_pdf`, `release_path`, `release_sha256`, and `release_bytes` alongside the existing `data_dir`, `cover_image`, and `preview_pdf` fields.

`scripts/upload_sample_release.ts` reads every setting without hard-coding:
- Target registry path from `GLOBAL.storefront.book_assets.sample_the_quiet_workshop.book_registry` (`payments/src/settings_registry.ts`).
- Delivery bucket from `GLOBAL.delivery.bucket` (`"release-files"`).
- HTTP timeout from `GLOBAL.payments.sync_http_timeout_ms` (`30000` ms).
- File path, object key, expected SHA-256, and expected byte count (`501,698`) from `books/sample_the_quiet_workshop.json`.
- Credentials (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`) from `process.env` only when not running `--dry-run` (never calls `dotenv`, never prints secrets).

Execution safeguards:
1. **Pre-upload check:** Reads the local PDF, verifies `bytes === 501698` and `sha256 === '74751711467a13e89b98d10a4e5e490d82fc11c2463f37f5d77f4ab320b635d9'`, and refuses before any network call if either differs.
2. **`--dry-run`:** Stops immediately after pre-upload verification and prints JSON with `verifiedBefore: true`, `uploaded: false`.
3. **Upload + readback check:** Sends `POST` with `x-upsert: false`. On `200 OK` or `201 Created` (or `409 Conflict` / duplicate `400 Bad Request` when already uploaded), sends `GET` to read back the remote bytes, checks byte length and SHA-256 against the SSOT, and refuses loudly if the remote hash or size differs.
4. **Named HTTP meanings:** Maps `200 OK`, `201 Created`, `400 Bad Request`, `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `409 Conflict`, `413 Payload Too Large`, `422 Unprocessable Entity`, `429 Too Many Requests`, `500 Internal Server Error`, `502 Bad Gateway`, `503 Service Unavailable`, and `504 Gateway Timeout`.

## 3. Deliverable 3: Storefront Behavior for a Non-Live Product

By reading `web/app/books/page.tsx`, `web/app/books/[handle]/page.tsx`, `web/app/books/[handle]/[product]/page.tsx`, `web/src/components/storefront/storefront.tsx`, and `web/src/lib/book-assets.ts`:

| Route | HTTP Status | Behavior when `checkout_mode` is `'gated'` / non-live |
|---|---|---|
| `/books` (`B2cLandingPage` -> `fetchB2cLanding`) | `200 OK` | **Hides it.** PostgREST applies `.eq("products.checkout_mode", "live")` with `products!inner(...)` and JS filters `p.checkout_mode === "live"`. If no other book is live, renders `"No books are on sale yet. Please check back soon."` with `robots: noindex, nofollow`. |
| `/books/expanpress_house` (`CreatorHubPage` -> `fetchCreatorHub`) | `200 OK` | **Hides it.** Creator exists with one commercial `store_product_id`, so the hub renders `200 OK` (`robots: noindex, nofollow`), but `commercial.filter((p) => p.checkout_mode === "live")` drops the sample from `Publications` and renders `"No books are on sale yet. Please check back soon."`. |
| `/books/expanpress_house/sample_the_quiet_workshop` (`StoreProductPage` -> `fetchStoreProduct`) | `200 OK` | **Renders the full preview page in a non-buyable state.** `fetchStoreProduct` does not filter on `checkout_mode`. It resolves `cover_image` (`/books/covers/sample_the_quiet_workshop.webp`), `preview_pdf` (`/books/previews/sample_the_quiet_workshop.pdf`), and `is_sample: true` from `books/sample_the_quiet_workshop.json` (bundled via `outputFileTracingIncludes` in `web/next.config.ts`), sets `robots: noindex, nofollow`, displays `"Published by ExpanPress"`, `$9.00 USD · one-time`, and `<p aria-disabled="true" data-checkout-slot="primary" data-checkout-mode="gated">Coming soon — not yet available for purchase</p>` (no `BuyLink`), hides footer buyer legal links (`showBuyerLegal={false}`), and **renders `<BookPreviewer>`** so visitors can flip through the sample preview PDF. |
| `/api/billing/checkout?product=expanpress_house/sample_the_quiet_workshop` | `403 Forbidden` | Fails closed with `"Checkout forbidden: product is not launched"` (when `checkout_mode = 'gated'`; `'sandbox'` also returns `403 Forbidden` in production). |
| `https://pay.expanpress.com/checkout/9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc` | `200 OK` | Renders product summary and Merchant of Record disclosure with the disabled `Coming soon — not yet available for purchase` pill (no `BuyerEmailStep`, no Paddle overlay, buyer legal links hidden). |

### Minimal Registry-Driven Change to List a Non-Live SAMPLE on `/books`

Because `/books` currently hides every non-live product, letting a non-live sample appear on `/books` in a non-buyable state requires **no hard-coding** and only these minimal changes (not applied here so existing `fetchB2cLanding` tests and launch behavior stay untouched until requested):

1. **`payments/src/settings_registry.ts` (`GlobalSettings.storefront` + `DEFAULT_GLOBAL.storefront` + `loadStorefrontSection`):**
   - Add `show_non_live_samples: boolean` (default `false` — fail-closed so existing behavior does not change unless explicitly enabled).
   - Add `coming_soon_badge: string` (default `"Coming soon"`), `sample_preview_cta: string` (default `"Preview sample"`), and `allowed_non_live_sample_modes: string[]` (default `["gated"]`) so copy and modes come strictly from the registry.
2. **`web/src/components/storefront/storefront.tsx` (`fetchB2cLanding` and `BookCard`):**
   - In `fetchB2cLanding`: when `GLOBAL.storefront.show_non_live_samples` is `true`, replace `.eq("products.checkout_mode", "live")` with `.in("products.checkout_mode", ["live", ...GLOBAL.storefront.allowed_non_live_sample_modes])`, call `withResolvedAssets` on each product, and retain `p.checkout_mode === "live" || p.is_sample` (non-sample gated books remain hidden).
   - In `BookCard`: accept `checkout_mode` on `product`; when `product.checkout_mode !== "live"`, render a non-buyable pill using `GLOBAL.storefront.coming_soon_badge` (and keep the link to `/books/${creatorHandle}/${slug}`, where `<BookPreviewer>` renders and checkout stays disabled). Keep `NOINDEX` whenever no listed product is `live`.
3. **Note on `docs/testing/pairwise/billing_consent_checkout.model.txt`:** This task changed zero checkout or consent inputs, so no PICT model update was required.

## 4. Deferred MEDIUM Findings

From `pnpm qa:intel` (`tsx scripts/qa-intel.ts --mode diff --base origin/main --compare`) and `tsx scripts/qa-intel.ts --mode working-tree` (0 CRITICAL, 0 HIGH):
- **MEDIUM (deferred):** `scripts/upload_sample_release.ts` — `ARTAS V10` response body buffered via `postRes.arrayBuffer()` / `getRes.arrayBuffer()` without an explicit byte-cap reader loop, plus 2 catch blocks without error logging.
- **MEDIUM (deferred):** `web/src/components/storefront/book-previewer.tsx` — 2 pre-existing catch blocks without error logging.
- **MEDIUM (deferred):** `web/src/lib/book-assets.ts` — 3 pre-existing catch blocks without error logging.
- **LOW (deferred):** Single-letter parameter names (`v`, `b`, `n`, `p`) in `payments/book_identity.ts`, `payments/src/settings_registry.ts`, `web/src/components/storefront/book-previewer.tsx`, and `web/src/components/storefront/storefront.tsx`.

## 5. Verification Commands Run

- `pnpm exec tsx scripts/upload_sample_release.ts --dry-run` -> verified `bytes: 501698`, `localSha256: "74751711467a13e89b98d10a4e5e490d82fc11c2463f37f5d77f4ab320b635d9"`, `bucket: "release-files"`, `objectKey: "release/9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc_release.pdf"`, `verifiedBefore: true`, `uploaded: false`.
- `pnpm exec vitest run payments/test/sample_listing_prod_sql.test.ts payments/test/upload_sample_release.test.ts payments/test/book_preview_settings.test.ts web/__tests__/book-assets.test.ts web/__tests__/storefront.test.ts web/app/books/[handle]/[product]/__tests__/page.test.ts` -> 6 files passed, 47 tests passed.
- `pnpm exec tsc --noEmit` -> exit 0.
- `pnpm --dir web type-check` -> exit 0.
- `pnpm lint` -> exit 0 (0 errors, 16 pre-existing warnings).
- `pnpm --dir web lint` -> exit 0 (0 errors, 6 pre-existing warnings).
- `pnpm qa:intel` -> 0 CRITICAL, 0 HIGH (8 pre-existing MEDIUM/LOW on branch files deferred above).

## 6. Operator Execution Checklist (Not Run Here)

When I am ready to provision production (requires operator DB role and service credentials, without printing secrets):

1. Run `supabase/manual/sample_listing_prod.sql` as operator (`postgres` / `supabase_admin`) in Supabase SQL Editor and confirm `hash_matches_pin = true` and `launch_block_reason = NULL`.
2. Export `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in a clean operator shell and run:
   `pnpm exec tsx scripts/upload_sample_release.ts --file /home/kellyb_dev/projects/hex-expan/data/books/house_expanpress/the_quiet_workshop/ExpanPress_Sample_TheQuietWorkshop_EliasHartwell_2026.pdf`
3. Probe `/books/expanpress_house/sample_the_quiet_workshop` (`200 OK`, `noindex`, `Coming soon`, previewer renders) and `/api/billing/checkout?product=expanpress_house/sample_the_quiet_workshop` (`403 Forbidden`).
