# The Quiet Workshop: listing runbook (not executed)

**Date:** 2026-11-19. **Branch:** `feat/quiet-workshop-listing` (from `origin/main` a2eae74). **Identity file:** `books/the_quiet_workshop.json`.

**Status: NOT READY TO LIST.** This runbook covers the production steps only. Nothing was written to production, Paddle, storage or any `.env`. Read-only SQL on the live project was used to verify the current state.

## 1. Blockers

Each blocker must clear before the step that depends on it runs.

| ID | Blocker | Evidence (checked) | Owner | Clears when |
|---|---|---|---|---|
| B1 | The local sample PDF is not sellable. | `data/books/house_expanpress/the_quiet_workshop/ExpanPress_TheQuietWorkshop_EliasHartwell_2026.pdf` (11 pages, sha256 `a06f9979...ebe0a8`) shows "SAMPLE COPY · NOT FOR SALE" on page 1 and "Not for sale" in the body. | Founder | A buyer-clean release PDF exists, with its own sha256, and the founder approves it. |
| B2 | The author credit describes a made-up person. | The PDF body reads "Elias Hartwell is a made-up name for this sample. The publisher is ExpanPress." | Founder, with legal review | The founder decides the byline (see D4). |
| B3 | Paddle live account is not approved. | `docs/handover/THOS_KYC_ROLLING.md`, 2026-11-12 and 2026-11-17 entries: Paddle KYC "NOT STARTED"; `pay.expanpress.com` pending review. | Founder | Paddle approves the live account. Live products cannot be created before that. |
| B4 | No house creator, no signer, no consents. | Live `public.creators`: 4 rows, none is a house creator. Live `public.consents`: C1 given x2, C2 given x2, **C3 zero rows**. C3 can be written only by the e-sign webhook (`supabase/migrations/20261116142329_consents_supersedes_set.sql`, line 199). | Founder | C1, C2 and C3 are given for the house creator through the e-sign flow. |
| B5 | The sync script handles one book only. | `payments/sync_book_identity.ts` line 50 throws "sync target ambiguous" when more than one `products` row carries `book_registry`. Live: exactly one row (Duane). Adding this book breaks the Duane sync. | Code (PR) | The target is chosen by book id or product id, with tests. |
| B6 | The subtitle is a placeholder. | `books/the_quiet_workshop.json` `subtitle`. The sync writes it to the Paddle product description. | Founder | The founder supplies the subtitle. |
| B7 | The price is not approved. | `books/the_quiet_workshop.json` `price.usd` = 9.00, status PROPOSED. | Founder | The founder approves a price (see D1). |
| B8 | The release hash is not set. | The launch trigger (`public.enforce_launch_gate`) and the checkout route both require `products.release_sha256` to equal the C2 `document_sha256`. | Ops | After B1 and B4. |
| B9 | Paddle state is unverified from this session. | The Paddle MCP connection timed out. Live Paddle state was not read. | Ops | Verify with the Paddle dashboard or a direct read before S6. |

## 2. Decisions

Each option lists the industry norm, the recommendation, and the trade-offs.

**D1. Price (B7).**
- **A. $9.00 (recommended, PROPOSED).** Standard for a single-PDF product that is bought on impulse. Sits well below the $39 flagship. Why yes: low friction for a first sale. Why no: the fixed per-transaction fee is a larger share of a low price, so check the Paddle fee schedule before the final choice.
- B. $19.00. Standard for a full-length guide. Why yes: better margin per sale. Why no: higher friction for a sample-scale product.
- C. $4.99. Why yes: lowest friction. Why no: the fixed fee can exceed a large share of the revenue.
- Not an option: $0. The `price_usd` column is `CHECK (price_usd > 0)`.

**D2. Creator of record.**
- **A. House creator `expanpress_house` (recommended).** Industry norm: an imprint model, where the publisher is the seller of record. Why yes: the founder can sign the consents as a real person. The handle is not reserved (checked against `GLOBAL.handles.reserved`). Why no: the storefront shows "ExpanPress" as the creator.
- B. A creator row named for the fictional author. Not viable: no real person exists to sign C1, C2 or C3.
- C. The existing test creator. Rejected: test identities must not appear in the live namespace (ADR 0065, rule 4), and the test creator is not a real signer.

**D3. Release file (B1).**
- **A. A new buyer-clean PDF (recommended).** Industry norm: the sold file is the final artifact, and it carries no sample or draft markers. Why yes: it is the only thing a buyer can legitimately receive. Why no: it needs production time.
- B. Sell the existing sample. Rejected: it is marked "NOT FOR SALE" in its own text.

**D4. Byline (B2).**
- **A. Publisher-only credit: "ExpanPress" (recommended).** Requires a `books/the_quiet_workshop.json` change to `author`. Why yes: no fictional person appears on a paid page. Why no: the title loses the named-author framing.
- B. Keep "Elias Hartwell" as the author with an explicit pen-name disclosure. Requires legal review before listing. Why yes: matches the founder's stated intent. Why no: a made-up name on a paid listing carries a misrepresentation risk.

## 3. Production steps (in order)

Each write step needs the founder's explicit approval, recorded in the ledger, before it runs. Only the steps marked READ run without approval.

**S0. Preconditions.** B1 to B9 cleared, or the step that needs them is held.

**S1. Create the house creator (WRITE, DB).** Confirm the `public.creators` and `public.creator_users` columns with a read first. Then insert the `creators` row (`handle` = `expanpress_house`, `display_name` = `ExpanPress`) and one `creator_users` row for the founder's auth user. Writes go through the service role. Verify with a SELECT.

**S2. Upload the release PDF (WRITE, storage).** Bucket `release-files`, private (verified read-only: `public = false`). Proposed object path: `house_expanpress/the_quiet_workshop/ExpanPress_TheQuietWorkshop_EliasHartwell_2026.pdf`. Confirm the path convention against the existing upload script first (`scripts/sync-supabase-to-r2.ts` reads from `SUPABASE_STORAGE_BUCKET`, default `release-files`). Compute the sha256 locally. Verify the object exists after upload, without making it public.

**S3. Insert the product row (WRITE, DB).** Fields: `creator_id` (from S1), `slug` = `the_quiet_workshop`, `title`, `description`, `price_usd` = the approved price, `currency` = `USD`, `store_product_id` = a unique provider key (proposed `house_the_quiet_workshop_v1`), `pdf_file` (from S2), `release_sha256` (from S2), `release_state` = `release`, `release_year` = 2026, `checkout_mode` = `gated`. Set `book_registry` = `books/the_quiet_workshop.json` only after B5 is fixed. Otherwise the Duane sync fails. Do not set the derived identifier columns. They were dropped on 2026-11-16.

**S4. Record consents (WRITE, legal evidence).** C1 and C2 through the creator consent flow. C2's `document_sha256` must equal the S2 sha256. C3 through the Firma e-sign flow. Never insert consent rows by hand. They are legal evidence. The `submit_consent` RPC rejects a C3 write from any caller that is not the service role, which is the e-sign webhook's role (`20261116142329`, line 199).

**S5. Add the Paddle rail (WRITE, DB).** `public.product_rails`: `provider` = `paddle`, `weight` = 1, `active` = true, `checkout_url` = the Paddle hosted checkout URL for the live price. The URL must be `https`, and a live rail must not use a sandbox host (`checkoutUrlProblem` in `web/app/api/billing/checkout/route.ts`).

**S6. Paddle product and price (EXTERNAL WRITE).**
- Live (after B3): create the product with `name` = title, `description` = subtitle, and `custom_data` carrying `store_product_id`. Create a USD price for the approved amount. Record the `pro_` and `pri_` ids in `products.paddle_product_ref` and `products.paddle_price_id`.
- Sandbox: the same in the Paddle sandbox. The sync's sandbox apply is refused unless `--sandbox-db-ref` matches the `SUPABASE_URL` project ref (`assertApplyAllowed`, `payments/sync_book_identity.ts`). Run any sandbox apply only against the test project (`hex-expan-test`), never against production.

**S7. Identity sync (REMOTE WRITE, after B5).**
1. `PADDLE_ENVIRONMENT=sandbox pnpm exec tsx payments/sync_book_identity.ts --check` (read-only). The script has no dry-run flag. `--check` is its read-only mode.
2. Read the mismatch list. Apply only when it matches the expected changes.
3. Apply, then re-run `--check` to confirm all targets match the registry.

The offline payload dry run is in section 5.

**S8. Go live (WRITE, public).** Set `products.checkout_mode` = `live`. The `products_launch_gate` trigger re-checks C1, C2, C3 and the release hash, and rejects the change if any check fails. The product then appears on `/books` (the live-only query in `fetchB2cLanding`).

**S9. Verification probes (READ-ONLY).** Run P1 to P2 before S8 (expect the product not listed) and again after it.

| ID | Command | Expected |
|---|---|---|
| P1 | `curl -sS -o /dev/null -w '%{http_code}\n' https://expanpress.com/books` | 200. After S8, the body contains "The Quiet Workshop". Before S8, it does not. |
| P2 | `curl -sS -o /dev/null -w '%{http_code}\n' https://expanpress.com/books/expanpress_house/the_quiet_workshop` | 200. Before S8 the page should carry a `noindex` robots meta; `storefrontRobots` sets it when no live product exists. Verify on the product page itself. |
| P3 | `curl -sS -o /dev/null -w '%{http_code}\n' https://pay.expanpress.com/checkout/<product-uuid>` | 200 once live. Unknown ids return 404 (`web/app/checkout/[productId]/page.tsx`). |
| P4 | `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' 'https://expanpress.com/api/billing/checkout?product=expanpress_house/the_quiet_workshop'` | Read the success status in `web/app/api/billing/checkout/route.ts` before running. The route must not return 403 or 500 once live. |
| P5 | Sentry: no new unresolved issues in the window after S8. | Clean. |

Probes use no credentials.

**Rollback.** Set `checkout_mode` back to `gated`. Set the `product_rails` row to `active` = false. Archive the Paddle product rather than deleting it. Never delete consent rows.

## 4. Time estimate

Estimates, not measurements. Active work only.

| Step | Estimate | Note |
|---|---|---|
| Decisions D1 to D4 | 15 to 30 min | Founder |
| Buyer-clean release PDF (B1) | 30 to 60 min | Founder or designer |
| Paddle live approval (B3) | Not estimated | No evidence for a duration. KYC was "not started" on 2026-11-17. |
| Sync fix for multiple books (B5) | 1 to 2 h | Code, tests and PR |
| S1 to S3 (creator, upload, product row) | 20 to 30 min | Each write needs approval |
| S4 consents via e-sign | 15 to 30 min plus signer turnaround | Founder signs |
| S5 and S6 (rail, Paddle product and price) | 30 to 60 min | Live step depends on B3 |
| S7 sync check and apply | 10 min | |
| S8 and S9 (go live and probes) | 15 min | |

Active work after the blockers clear: about 3 to 4 hours, plus the Paddle approval wait and the signer turnaround.

## 5. Appendix: offline dry run (2026-11-19)

Run with a recording fetch stub, placeholder ids and no network. It uses the real `loadBookIdentity`, `applyIdentity`, `fetchTargetState` and `mismatchList`.

| Check | Result |
|---|---|
| Identity loads from `books/the_quiet_workshop.json` | PASS (`id`, `title`, `subtitle`, `author` non-empty) |
| ADR 0065 shape, product slug `the_quiet_workshop` (18 chars) | PASS |
| ADR 0065 shape, creator handle `expanpress_house` (16 chars) | PASS |
| Post-apply mismatch list | empty |
| Planned Supabase PATCH | `products?id=eq.<db_product_id>` with body `{"title":"The Quiet Workshop"}` |
| Planned Paddle PATCH | sandbox base, `products/<pro_id>` with body `{"name":"The Quiet Workshop","description":"PENDING: ... subtitle"}` |
| Planned reads (`--check`) | GET Supabase `products?...&select=title` and GET Paddle `products/<pro_id>` |

The dry run exposes the placeholder subtitle (B6). It would be sent to Paddle as the product description.

Dry-run script (not committed): `/tmp/claude-1001/-home-kellyb-dev-projects-hex-expan/21b00acc-7513-46d6-9a35-038af7845be2/scratchpad/quiet_dryrun.mts`.

## 6. Sources

- `payments/sync_book_identity.ts`, `payments/book_identity.ts`
- `supabase/migrations/20261007000000_commercial_heritage.sql` (products and product_rails)
- `supabase/migrations/20261009000000_launch_trigger_and_audit.sql` and `20261116142329_consents_supersedes_set.sql` (launch gate)
- `supabase/migrations/20261103134245_products_release_lifecycle.sql`
- `docs/adr/0060-universal-consent-enforcement.md`, `docs/adr/0061-payment-domain-pay-subdomain.md`, `docs/adr/0065-identifier-rules.md`
- `web/app/books/` and `web/src/components/storefront/storefront.tsx` (live-only storefront)
- `web/app/api/billing/checkout/route.ts` (consent, release-hash and rail gates)
