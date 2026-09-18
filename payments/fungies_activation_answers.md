# Fungies: activation answers + product form values (v2, 2026-09-16 20:5x)

Prep-first workflow: build everything now, activate when ready. Activation review is ≤24h
per their docs (faster than the 5-day assumption). Fill the [USER:] fields, everything else
is copy-paste. Source facts: payments/config.duane.json · data/intel/fungies_deep_dive_2026-09-15.md ·
data/intel/duane_persona_v2_2026-09-16.md. Prior version: fungies_activation_answers.v1-2026-09-16.md
(superseded — v1 was drafted before the IG handle was resolved and before the MoR/tax-handling
language was standardized across all provider forms).

**What changed in v2:** made MoR/tax-handling language explicit per the standard wording now used
on every provider form (see Purpose of Usage below); cover/gallery TODOs resolved to real file paths
(PDF polish round 4 delivered them); confirmed YouTube handle @retirearly500k (78,400 subs) and
Instagram @retirearly500 (90,069 followers) — duane500k was never a real handle, it was Duane's
email prefix, closed via live IG lookup.

---

## A. Store Activation form (Settings → Store → Add Business Details)

| Field | Answer |
|---|---|
| Full Name | [USER: your full legal name] |
| Contact Email | [USER: your email — this receives activation status + compliance notices] |
| Address | [USER: your Egyptian address, matching your ID + bank profile] |
| City & Country | Cairo, Egypt |
| Website URL | https://expanpress.com/c/retirearly500k/500k-playbook/ (live product page, nested under the creator hub) — or https://expanpress.com |
| Social Media URL | https://www.youtube.com/@retirearly500k (the creator's channel; our brand presence is the product site) |
| Business Description | Independent digital publisher. Solo founder based in Egypt creating practical personal-finance PDF playbooks in collaboration with established finance creators (revenue-share model). First product: a retirement money-management playbook co-created with a US creator (77k+ YouTube, 90k+ Instagram). |
| Products or Services | Digital PDF products (educational personal-finance playbooks), one-time purchase, $19 USD, delivered as instant download. Sold to a US/EU-leaning English-speaking audience. No subscriptions at launch. |
| Purpose of Usage | To process checkout and payment collection for digital product sales, manage revenue-share payouts between ExpanPress and each collaborating creator, and handle customer receipts and refunds. We rely on the provider acting as Merchant of Record, collecting and remitting applicable sales tax/VAT on each transaction, plus cross-border payouts to an Egyptian bank (EGP via Stripe Connect) — Egypt is on your published 121-country seller list. |
| Do You Already Have Customers? | No — pre-launch (first product in final approval) |

## B. "Add Digital Download" product form (sandbox — build now, publish after signing)

| Field | Value |
|---|---|
| Name (required) | Retire on $500K: The Early-Retirement Money Playbook |
| Description (≤5000 words) | A practical money-management playbook for the retirement years: the instruments, the sequence, and the recovery playbook after a market crash — built on one early retiree's real $500K journey. Not financial advice. (Full long-form description: pending final PDF copy — keep this short version for the sandbox build.) |
| Cover | typst_prototype/img_v3/cover_1500x2400.png (1500×2250 @250ppi, 0.84MB — delivered by PDF polish round 4) |
| Cover Video (optional) | https://www.youtube.com/watch?v=EyEwIrhGKoI (Duane's own video — ONLY wire after the data-use + likeness agreement is signed; leave image cover in sandbox) |
| Gallery (0-10) | typst_prototype/img_v3/gallery_p1.png, gallery_p2.png, gallery_p3.png (preface / ch1-opener / timeline, @144ppi, each <1MB — delivered by PDF polish round 4) |
| Feature list | + "The exact $500K instrument sequence, step by step" · + "Post-crash recovery playbook" · + "Real numbers from a real early retirement" · + "Instant PDF download, 80+ pages" |
| Price | $19.00 USD, one-time |
| Checkout | Hosted; thank-you redirect → https://expanpress.com/c/retirearly500k/500k-playbook/ |

## C. Optional belt-and-braces: support@fungies.io / Discord question

> "Confirming seller onboarding for Egypt: your published Global Availability list includes
> Egypt (121 countries), and your payout table shows EGP settlement (min 20 EGP). We are a
> Cairo-based individual seller planning to connect our own Stripe account for payouts
> (Egyptian ID + EGP bank). Anything to be aware of for Egypt-based sellers on Stripe Connect
> payouts through Fungies?"

## D. Open items

- [USER] activation form fields marked [USER: …]
- [USER] product form: sign-off on Name/Description/Feature list wording
- [x] cover image + gallery exports from the v3 PDF — DONE, PDF polish round 4 (paths above)
- [x] Fungies API catalog build — DONE: 2 DRAFT products (duane500k, identity-after-exit),
  3 offers, checkout element ACTIVE (data/db/fungies_catalog.json). Note: `customFields` is
  NOT API-settable — webhook correlation uses `externalId→internalId` instead; update the
  webhook adapter accordingly before go-live.
- [known issue] the routing slug `payments/site/c/duane500k/` is itself an email-prefix
  artifact, not a real handle (same root cause as the IG lookup miss below) — flagged in
  .memory/AGENT_LEDGER.md 2026-09-16T20:42, not yet renamed. Fix before using this doc's
  Website URL field for a second creator.
- [gate] publish NOTHING live until Duane signs the data-use + revenue-split agreement

## E. Resolved since v1

- IG handle: `duane500k` was never real — it was Duane's email prefix, confirmed via a live
  UserNotFound response. Real handle: `@retirearly500` (90,069 followers). YouTube handle
  `@retirearly500k` (78,400 subs) was already correct.
- Cover Video / Social Media URL fields above should eventually point at the verified handles,
  not any email-derived string.
