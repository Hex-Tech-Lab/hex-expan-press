# The Quiet Workshop: listing runbook (not executed)

**Date:** 2026-11-19. **Branch:** `feat/quiet-workshop-listing` (from `origin/main` a2eae74). **Identity file:** `books/sample_the_quiet_workshop.json`.

**Status: SAMPLE LISTING PREPARED, NOT LISTED.** Updated 2026-11-19 (task `quiet-workshop-sample-label`, founder decision, final). The product is the sample, Chapter 1 of a 12-project book in progress, at $9.00 under the slug `sample_the_quiet_workshop` (§8). Closed by founder decision: B1, B2, B6, B7 and B10. B11 is the founder's manual Acrobat export; automation waits for KYC. B3, B4, B8 and B9 remain open. Nothing was written to production, Paddle, storage or any `.env`.

## 1. Blockers

Each blocker must clear before the step that depends on it runs.

| ID | Blocker | Evidence (checked) | Owner | Clears when | Status (2026-11-19) |
|---|---|---|---|---|---|
| B1 | The release PDF is not sellable as the full book. | `data/books/house_expanpress/the_quiet_workshop/ExpanPress_TheQuietWorkshop_EliasHartwell_2026.pdf` (sha256 `a06f9979...ebe0a8`) is the old sample, marked "SAMPLE COPY · NOT FOR SALE". It must not be uploaded or sold. | Founder | Founder decision (D3, D5): the sold file is the sample master, marked "Sample: Chapter 1 of 12", exported by the founder (B11). | CLOSED by founder decision on 2026-11-19. The sample master is described in §8. The old release file is not used by the identity. |
| B2 | The author credit describes a made-up person. | The old PDF body reads "Elias Hartwell is a made-up name for this sample. The publisher is ExpanPress." | Founder, with legal review | The founder decides the byline (see D4). | CLOSED by the founder's decision on 2026-11-19: byline "Elias Hartwell", pen-name line "Elias Hartwell is a pen name. Published by ExpanPress." Legal review of that line is not verified here. |
| B3 | Paddle live account is not approved. | `docs/handover/THOS_KYC_ROLLING.md`, 2026-11-12 and 2026-11-17 entries: Paddle KYC "NOT STARTED"; `pay.expanpress.com` pending review. | Founder | Paddle approves the live account. Live products cannot be created before that. | OPEN. Not changed in this task. |
| B4 | No house creator, no signer, no consents. | Live `public.creators`: 4 rows, none is a house creator. Live `public.consents`: C1 given x2, C2 given x2, **C3 zero rows**. C3 can be written only by the e-sign webhook (`supabase/migrations/20261116142329_consents_supersedes_set.sql`, line 199). | Founder | C1, C2 and C3 are given for the house creator through the e-sign flow. | OPEN. |
| B5 | The sync script handled one book only. | `payments/sync_book_identity.ts` threw "sync target ambiguous" when more than one `products` row carried `book_registry`. Live: exactly one row (Duane). | Code (PR) | The target is chosen by book id or product id, with tests. | CLEARED on branch `feat/quiet-workshop-listing`. `--book <id>` and `--product <products.id>` select the target. With no selector and two books it fails closed and names the choices. The single-book Duane path is unchanged. Tests: `payments/test/sync_book_selection.test.ts` (23) and `payments/test/book_identity.test.ts`. The 500-row read limit moved to the registry (`sync_products_query_limit`). |
| B6 | The subtitle is a placeholder. | `books/sample_the_quiet_workshop.json` `subtitle`. The sync writes it to the Paddle product description. | Founder | The founder supplies the subtitle. | CLOSED (founder decision, 2026-11-19): "Twelve Practical Projects for a Small Home Bench", the wording in `manuscript.md`. The cover sets the same words in sentence case. |
| B7 | The price is not approved. | `books/sample_the_quiet_workshop.json` `price.usd` = 9.00. | Founder | The founder approves a price (see D1). | CLOSED: $9.00 USD, approved by the founder on 2026-11-19 (D1-A). Unchanged by the sample relabel. |
| B8 | The release hash is not set. | The launch trigger (`public.enforce_launch_gate`) and the checkout route both require `products.release_sha256` to equal the C2 `document_sha256`. | Ops | After B1 and B4. | OPEN. The sha256 of the unexported master (§7) must not be used here. |
| B9 | Paddle state is unverified from this session. | The Paddle MCP connection timed out. Live Paddle state was not read. | Ops | Verify with the Paddle dashboard or a direct read before S6. | OPEN. |
| B10 | The source is chapter 1 of the 12 listed. | `manuscript/sample_book/manuscript.md` holds the front matter and Chapter 1 only. Its Contents lists twelve chapters. A repo-wide search for "quiet workshop" finds no other manuscript. Selling this file as the book would sell one chapter under a 12-chapter description. | Founder | The full 12-chapter manuscript is supplied and checked; or the founder decides to sell a different product (for example a sample), with a title and description that match its content. | CLOSED by founder decision on 2026-11-19 (D5, option A): the product is "The Quiet Workshop (Sample)", Chapter 1 of 12, titled and described as a sample. The Contents page still lists all 12 chapters; the marking states the scope. |
| B11 | No repeatable export pipeline (optimisation, hashing, fingerprint, watermark). | `docs/handover/THOS_KYC_ROLLING.md` (2026-11-18 entry): "standard PDF optimisation step (founder Acrobat recipe -> repeatable tool)" is OPEN. `scripts/watermark_pdf.py` has no buyer purpose, drops `/StructTreeRoot` (AGENTS.md P-36: Acrobat and Edge then show blank pages), and has the overlay defects recorded in `docs/integrations/pdf-stamping-decision.html`. The per-buyer stamp design (pdf-lib, option B) is a 2026-10-31 recommendation, not built. | Founder (manual export now); code after KYC | The founder runs the Acrobat recipe (`docs/ops/PDF_EXPORT_ACROBAT_RECIPE.md`) by hand on the sample master. The export passes a tag check, `pdftotext`, and `scripts/pdf_a11y_check.sh`. Automation waits until after KYC. | OPEN (founder action, by hand). Blocks B8. |

## 2. Decisions

Each option lists the industry norm, the recommendation, and the trade-offs.

**D1. Price (B7).** Decided 2026-11-19: option A.
- **A. $9.00 (APPROVED by the founder).** Standard for a single-PDF product that is bought on impulse. Sits well below the $39 flagship. Why yes: low friction for a first sale. Why no: the fixed per-transaction fee is a larger share of a low price, so check the Paddle fee schedule before the final choice.
- B. $19.00. Standard for a full-length guide. Why yes: better margin per sale. Why no: higher friction for a sample-scale product.
- C. $4.99. Why yes: lowest friction. Why no: the fixed fee can exceed a large share of the revenue.
- Not an option: $0. The `price_usd` column is `CHECK (price_usd > 0)`.

**D2. Creator of record.**
- **A. House creator `expanpress_house` (recommended).** Industry norm: an imprint model, where the publisher is the seller of record. Why yes: the founder can sign the consents as a real person. The handle is not reserved (checked against `GLOBAL.handles.reserved`). Why no: the storefront shows "ExpanPress" as the creator.
- B. A creator row named for the pen name. Not viable: no real person exists to sign C1, C2 or C3.
- C. The existing test creator. Rejected: test identities must not appear in the live namespace (ADR 0065, rule 4), and the test creator is not a real signer.

**D3. Release file (B1).** Decided 2026-11-19: option A, the sample master (§8), exported by the founder (B11).
- **A. A new buyer-clean PDF (recommended).** Industry norm: the sold file is the final artifact, with no draft markers, and a sample says it is a sample. Why yes: it is the only thing a buyer can legitimately receive. Why no: it needs the founder's manual export (B11) before it can be sold.
- B. Sell the existing sample. Rejected: it is marked "NOT FOR SALE" in its own text.

**D4. Byline (B2).** Decided 2026-11-19: option B, the founder's stated intent.
- A. Publisher-only credit: "ExpanPress" (recommended by the earlier draft). Why yes: no fictional person appears on a paid page. Why no: the title loses the named-author framing.
- **B. Keep "Elias Hartwell" as the author with an explicit pen-name disclosure (chosen).** The disclosure is "Elias Hartwell is a pen name. Published by ExpanPress." It appears on the title page and the back cover. Why yes: it matches the founder's intent and tells the buyer the name is a pen name. Why no: it still needs legal review before listing, as the earlier draft noted. That review is not verified here.

**D5. Sample label (B10).** Decided 2026-11-19 by the founder: option A, final. Price, title and subtitle are not reopened.
- **A. Sell a labelled sample (chosen; recommended).** "The Quiet Workshop (Sample)", Chapter 1 "Setting Up the Bench" of a 12-project book in progress, at $9.00. Industry norm: a sample or first chapter is sold at a low price with a clear label on the title page, the back cover and the listing, so no buyer mistakes it for the full book. Why yes: it matches the content that exists, and it can be sold now. Why no: a buyer gets one chapter, and the full book needs its own product later.
- B. Sell the full 12-chapter book. Not possible: the manuscript holds Chapter 1 only (checked with `rg` on the headings).
- C. Sell Chapter 1 under the full title. Rejected: it would sell one chapter under a 12-chapter description (B10).

## 3. Production steps (in order)

Each write step needs the founder's explicit approval, recorded in the ledger, before it runs. Only the steps marked READ run without approval.

**S0. Preconditions.** B1 to B11 cleared, or the step that needs them is held.

**S1. Create the house creator (WRITE, DB).** Confirm the `public.creators` and `public.creator_users` columns with a read first. Then insert the `creators` row (`handle` = `expanpress_house`, `display_name` = `ExpanPress`) and one `creator_users` row for the founder's auth user. Writes go through the service role. Verify with a SELECT.

**S2. Upload the release PDF (WRITE, storage).** Upload only the exported file (B11). Never upload the unexported master. Bucket `release-files`, private (verified read-only: `public = false`). Proposed object path: `house_expanpress/sample_the_quiet_workshop/ExpanPress_Sample_TheQuietWorkshop_EliasHartwell_2026.pdf`. Confirm the path convention against the existing upload script first (`scripts/sync-supabase-to-r2.ts` reads from `SUPABASE_STORAGE_BUCKET`, default `release-files`). Compute the sha256 locally. Verify the object exists after upload, without making it public.

**S3. Insert the product row (WRITE, DB).** Fields: `creator_id` (from S1), `slug` = `sample_the_quiet_workshop`, `title` = "The Quiet Workshop (Sample)", `description` (from the identity file), `price_usd` = 9.00 (approved), `currency` = `USD`, `store_product_id` = a unique provider key (proposed `house_sample_the_quiet_workshop_v1`), `pdf_file` (from S2), `release_sha256` (from S2), `release_state` = `release`, `release_year` = 2026, `checkout_mode` = `gated`. Set `book_registry` = `books/sample_the_quiet_workshop.json`. B5 is fixed on this branch. With two book rows, every sync needs `--book` (see S7). Do not set the derived identifier columns. They were dropped on 2026-11-16.

**S4. Record consents (WRITE, legal evidence).** C1 and C2 through the creator consent flow. C2's `document_sha256` must equal the S2 sha256. C3 through the Firma e-sign flow. Never insert consent rows by hand. They are legal evidence. The `submit_consent` RPC rejects a C3 write from any caller that is not the service role, which is the e-sign webhook's role (`20261116142329`, line 199).

**S5. Add the Paddle rail (WRITE, DB).** `public.product_rails`: `provider` = `paddle`, `weight` = 1, `active` = true, `checkout_url` = the Paddle hosted checkout URL for the live price. The URL must be `https`, and a live rail must not use a sandbox host (`checkoutUrlProblem` in `web/app/api/billing/checkout/route.ts`).

**S6. Paddle product and price (EXTERNAL WRITE).**
- Live (after B3): create the product with `name` = title, `description` = subtitle, and `custom_data` carrying `store_product_id`. Create a USD price for $9.00. Record the `pro_` and `pri_` ids in `products.paddle_product_ref` and `products.paddle_price_id`.
- Sandbox: the same in the Paddle sandbox. The sync's sandbox apply is refused unless `--sandbox-db-ref` matches the `SUPABASE_URL` project ref (`assertApplyAllowed`, `payments/sync_book_identity.ts`). Run any sandbox apply only against the test project (`hex-expan-test`), never against production.

**S7. Identity sync (REMOTE WRITE, after B5 and S3).**
1. `PADDLE_ENVIRONMENT=sandbox pnpm exec tsx payments/sync_book_identity.ts --book sample_the_quiet_workshop --check` (read-only). The script has no dry-run flag. `--check` is its read-only mode. It prints `target:` (the registry file and the `products.id` it will touch) before any comparison. Without `--book`, the command fails while two products carry a `book_registry`. That is intended.
2. Read the mismatch list. Apply only when it matches the expected changes.
3. Apply with the same `--book sample_the_quiet_workshop`, then re-run `--check` to confirm all targets match the registry.

The offline payload dry run is in section 5.

**S8. Go live (WRITE, public).** Set `products.checkout_mode` = `live`. The `products_launch_gate` trigger re-checks C1, C2, C3 and the release hash, and rejects the change if any check fails. The product then appears on `/books` (the live-only query in `fetchB2cLanding`).

**S9. Verification probes (READ-ONLY).** Run P1 to P2 before S8 (expect the product not listed) and again after it.

| ID | Command | Expected |
|---|---|---|
| P1 | `curl -sS -o /dev/null -w '%{http_code}\n' https://expanpress.com/books` | 200. After S8, the body contains "The Quiet Workshop". Before S8, it does not. |
| P2 | `curl -sS -o /dev/null -w '%{http_code}\n' https://expanpress.com/books/expanpress_house/sample_the_quiet_workshop` | 200. Before S8 the page should carry a `noindex` robots meta; `storefrontRobots` sets it when no live product exists. Verify on the product page itself. |
| P3 | `curl -sS -o /dev/null -w '%{http_code}\n' https://pay.expanpress.com/checkout/<product-uuid>` | 200 once live. Unknown ids return 404 (`web/app/checkout/[productId]/page.tsx`). |
| P4 | `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' 'https://expanpress.com/api/billing/checkout?product=expanpress_house/sample_the_quiet_workshop'` | Read the success status in `web/app/api/billing/checkout/route.ts` before running. The route must not return 403 or 500 once live. |
| P5 | Sentry: no new unresolved issues in the window after S8. | Clean. |

Probes use no credentials.

**Rollback.** Set `checkout_mode` back to `gated`. Set the `product_rails` row to `active` = false. Archive the Paddle product rather than deleting it. Never delete consent rows.

## 4. Time estimate

Estimates, not measurements. Active work only.

| Step | Estimate | Note |
|---|---|---|
| Decisions D1 to D5 | Done 2026-11-19 | Founder decided D1 (A), D4 (B), D5 (A). |
| Sample label (B10) | Done 2026-11-19 | Founder decision: sell the sample (D5). |
| Sample master (B1) | Done 2026-11-19 | Rebuilt with the sample marking (§8). |
| Export (B11) | Not estimated | The founder runs the Acrobat recipe by hand. Automation waits until after KYC. |
| Paddle live approval (B3) | Not estimated | No evidence for a duration. KYC was "not started" on 2026-11-17. |
| Sync fix for multiple books (B5) | Done 2026-11-19 | Code and tests on `feat/quiet-workshop-listing`. |
| S1 to S3 (creator, upload, product row) | 20 to 30 min | Each write needs approval |
| S4 consents via e-sign | 15 to 30 min plus signer turnaround | Founder signs |
| S5 and S6 (rail, Paddle product and price) | 30 to 60 min | Live step depends on B3 |
| S7 sync check and apply | 10 min | |
| S8 and S9 (go live and probes) | 15 min | |

Active work after the blockers clear: about 2 to 3 hours, plus the Paddle approval wait, the signer turnaround, and the founder's B11 export, which is not estimated.

## 5. Appendix: offline dry run (2026-11-19)

Run with a recording fetch stub, placeholder ids and no network. It uses the real `loadBookIdentity`, `applyIdentity`, `fetchTargetState` and `mismatchList`.

| Check | Result |
|---|---|
| Identity loads from `books/the_quiet_workshop.json` (pre-sample name) | PASS (`id`, `title`, `subtitle`, `author` non-empty) |
| ADR 0065 shape, product slug `the_quiet_workshop` (18 chars, pre-sample name) | PASS |
| ADR 0065 shape, creator handle `expanpress_house` (16 chars) | PASS |
| Post-apply mismatch list | empty |
| Planned Supabase PATCH | `products?id=eq.<db_product_id>` with body `{"title":"The Quiet Workshop"}` |
| Planned Paddle PATCH | sandbox base, `products/<pro_id>` with body `{"name":"The Quiet Workshop","description":"<subtitle>"}` |
| Planned reads (`--check`) | GET Supabase `products?...&select=title` and GET Paddle `products/<pro_id>` |

Superseded in part by §8: the identity is now `books/sample_the_quiet_workshop.json`, with product slug `sample_the_quiet_workshop` (25 characters, which the ADR 0065 shape accepts). The table rows above ran against the earlier identity. Re-run the dry run before S7.

The original dry run exposed the placeholder subtitle (B6). That subtitle is now set (§7), so the Paddle description in the 2026-11-19 run would be the real subtitle. Re-run the dry run before S7.

Dry-run script (not committed): `/tmp/claude-1001/-home-kellyb-dev-projects-hex-expan/21b00acc-7513-46d6-9a35-038af7845be2/scratchpad/quiet_dryrun.mts`.

## 6. Sources

- `payments/sync_book_identity.ts` (`selectSyncTarget`, `fetchBookRegistryRows`, `flagValue`), `payments/book_identity.ts`
- `payments/src/settings_registry.ts` (`sync_products_query_limit`, `sync_http_timeout_ms`)
- `payments/test/sync_book_selection.test.ts` (two-book selection), `payments/test/book_identity.test.ts` (single-book sync)
- `manuscript/sample_book/` (the source; untracked in the main repo, so not in the commit): `manuscript.md`, `layout.typ` (the sample marking on the title page and back cover, §8), `body.typ` (generated by pandoc)
- `scripts/watermark_pdf.py`, `scripts/generate_bundle_manifest.py`, `scripts/pdf_a11y_check.sh`
- `docs/integrations/pdf-stamping-decision.html` (per-buyer stamp options, 2026-10-31), `AGENTS.md` P-36 (tag tree and Acrobat)
- `docs/handover/THOS_KYC_ROLLING.md` (2026-11-18 entry: optimisation step OPEN)
- `supabase/migrations/20261007000000_commercial_heritage.sql` (products and product_rails)
- `supabase/migrations/20261009000000_launch_trigger_and_audit.sql` and `20261116142329_consents_supersedes_set.sql` (launch gate)
- `supabase/migrations/20261103134245_products_release_lifecycle.sql`
- `docs/adr/0060-universal-consent-enforcement.md`, `docs/adr/0061-payment-domain-pay-subdomain.md`, `docs/adr/0065-identifier-rules.md`
- `web/app/books/` and `web/src/components/storefront/storefront.tsx` (live-only storefront)
- `web/app/api/billing/checkout/route.ts` (consent, release-hash and rail gates)

## 7. Status log: 2026-11-19 (task `quiet-workshop-sellable`)

- **Source (`manuscript/sample_book/`, untracked in the main repo).** `manuscript.md`: removed the sample Notice block and the "About This Sample" section; both were sample-only text. `layout.typ`: document title and author metadata; footer; cover notice; title-page sample lines; the back-cover sample paragraph and its "Edition / ISBN / Pages / Chapters" rows; the barcode placeholder box and the publisher sub-line. The pen-name line now sits on the title page and the back cover. `body.typ` was regenerated with the repo's pandoc 3.6.4, not hand-edited.
- **Master (unexported, for review only).** `data/books/house_expanpress/the_quiet_workshop/ExpanPress_TheQuietWorkshop_EliasHartwell_2026_master_unexported.pdf`. Built with typst 0.15.1 from `layout.typ`. 9 pages, 11,377,046 bytes, sha256 `c8db06ecaa5cef36c3b39a1f673bdceac2629b94cc90ba333ef2cd404ba41c9f`. Metadata: Title "The Quiet Workshop", Author "Elias Hartwell", tagged yes. This file is not the release: it is unoptimised, unhashed for release, unwatermarked, and it holds one chapter of twelve (B10).
- **Checks on the master.** `pdftotext -layout`: 0 matches for "not for sale", "made-up", "sample", "placeholder" and "test" (the old release has 24 matches). The pen-name line appears twice. Word diff against the old release: only the removed sample text and the page-number shift; the Chapter 1 text is identical. Cover, title and back pages were rendered and checked by eye.
- **Release path unchanged.** `data/books/house_expanpress/the_quiet_workshop/ExpanPress_TheQuietWorkshop_EliasHartwell_2026.pdf`, sha256 `a06f99794d61ac8b84bb74071c8f9935e8cc8b2eb016742cd975c1b064ebe0a8` (the old sample, still NOT FOR SALE). No `_sample_backup` was made, because the release path was not replaced.
- **Export not run (B11).** No optimisation step, watermark, fingerprint or release upload was run. The founder's rule is to stop when no export pipeline exists, and none does.
- **Code.** `payments/sync_book_identity.ts`, `payments/src/settings_registry.ts`, `payments/test/sync_book_selection.test.ts` (new), `books/the_quiet_workshop.json`. Gates: root `vitest run` 189 files, 2716 passed, 1 skipped; `pnpm exec tsc --noEmit` exit 0; `pnpm exec eslint src payments` 0 errors, 16 warnings, all pre-existing and none in the changed files.

## 8. Status log: 2026-11-19 (task `quiet-workshop-sample-label`, founder decision, final)

- **Decision (D5).** The product is the sample: "The Quiet Workshop (Sample)", Chapter 1 "Setting Up the Bench" of a 12-project book in progress. Price stays $9.00. The real subtitle stays. Not retitled, not repriced.
- **Identity.** `books/the_quiet_workshop.json` renamed to `books/sample_the_quiet_workshop.json` with `git mv`. `id` and `product_slug` are `sample_the_quiet_workshop` (25 characters; it passes the ADR 0065 shape: 3 to 30 characters, lowercase, single underscores). `description` added. `release.pdf_name` is `ExpanPress_Sample_TheQuietWorkshop_EliasHartwell_2026.pdf`, the name the founder gave. The release-name memory convention (`ExpanPress_<ProductSlugCamel>_...`) would give `SampleTheQuietWorkshop`; the founder's string was used.
- **Code.** `payments/test/sync_book_selection.test.ts` and the doc comments in `payments/sync_book_identity.ts` use the sample slug, path and fixture id `house_sample_the_quiet_workshop_v1`. The loader `payments/book_identity.ts` is unchanged.
- **Source (`manuscript/sample_book/`, untracked in the main repo, so not in the commit).** `layout.typ`: document title "The Quiet Workshop (Sample)"; "Sample: Chapter 1 of 12" on the title page under the author, and on the back cover under the tagline. The front cover has no marking, because the founder's list did not include it. `manuscript.md` and `body.typ` are unchanged: pandoc 3.6.4 regenerates `body.typ` byte-identical.
- **Master (unexported, review only).** `data/books/house_expanpress/the_quiet_workshop/ExpanPress_Sample_TheQuietWorkshop_EliasHartwell_2026_master.pdf`. Built with typst 0.15.1 from `layout.typ`. 9 pages, 11,378,793 bytes, sha256 `9db88731defc230c93bc1addcf71c4198e44778aa2daf8e111b082b5611650f2`. Metadata: Title "The Quiet Workshop (Sample)", Author "Elias Hartwell", tagged yes.
- **pdftotext checks (default mode).** "Sample": 2 matches (title page, page 2; back cover, page 9). "Sample: Chapter 1 of 12": 2. Pen-name line: 2. "not for sale": 0. "made-up": 0. Pages 2 and 9 were rendered and checked by eye.
- **Not run.** No optimisation, release hash, watermark, fingerprint or upload. The founder runs the Acrobat recipe by hand (B11). B8 sets `release_sha256` from that exported file.
- **Old files left on disk (not used by the identity).** The old release `ExpanPress_TheQuietWorkshop_EliasHartwell_2026.pdf` still reads "SAMPLE COPY · NOT FOR SALE". Do not upload or sell it. The earlier `..._master_unexported.pdf` has no sample marking. Both stay until the founder decides.
- **Blockers.** Closed by founder decision on 2026-11-19: B1, B2, B6, B7, B10. B11 is the founder's manual export. Open: B3 (Paddle live approval), B4 (house creator and consents), B8 (release hash, after B11 and B4), B9 (Paddle state unverified). The listing stays NOT_LISTED.
- **Gates (2026-11-19, worktree at this commit).** Root `vitest run`: 189 files, 2716 passed, 1 skipped. Targeted `payments/test/sync_book_selection.test.ts` and `payments/test/book_identity.test.ts`: 81 passed. `pnpm exec tsc --noEmit`: exit 0. `pnpm exec eslint src payments`: 0 errors, 16 warnings, the same count as before. The two changed payments files lint clean on their own.
