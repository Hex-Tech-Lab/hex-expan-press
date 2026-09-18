# Fungies: activation answers + product form values (2026-09-16)

Prep-first workflow: build everything now, activate when ready. Activation review is ≤24h
per their docs (faster than the 5-day assumption). Fill the [USER:] fields, everything else
is copy-paste. Source facts: payments/config.duane.json · data/intel/fungies_deep_dive_2026-09-15.md.

---

## A. Store Activation form (Settings → Store → Add Business Details)

| Field | Answer |
|---|---|
| Full Name | [USER: your full legal name] |
| Contact Email | [USER: your email — this receives activation status + compliance notices] |
| Address | [USER: your Egyptian address, matching your ID + bank profile] |
| City & Country | Cairo, Egypt |
| Website URL | https://expanpress.com/c/duane500k/ (live per-creator product page) — or https://expanpress.com |
| Social Media URL | https://www.youtube.com/@retirearly500k (the creator's channel; our brand presence is the product site) |
| Business Description | Independent digital publisher. Solo founder based in Egypt creating practical personal-finance PDF playbooks in partnership with established finance creators (revenue-share model). First product: a retirement money-management playbook co-created with a US creator (77k+ YouTube, 90k+ Instagram). |
| Products or Services | Digital PDF products (educational personal-finance playbooks), one-time purchase, $19 USD, delivered as instant download. Sold to a US/EU-leaning English-speaking audience. No subscriptions at launch. |
| Purpose of Usage | We need global payment processing with automatic VAT/sales-tax handling as merchant of record, and cross-border payouts to an Egyptian bank (EGP via Stripe Connect). Egypt is on your published 121-country seller list. |
| Do You Already Have Customers? | No — pre-launch (first product in final approval) |

## B. "Add Digital Download" product form (sandbox — build now, publish after signing)

| Field | Value |
|---|---|
| Name (required) | Retire on $500K: The Early-Retirement Money Playbook |
| Description (≤5000 words) | A practical money-management playbook for the retirement years: the instruments, the sequence, and the recovery playbook after a market crash — built on one early retiree's real $500K journey. Not financial advice. (Full long-form description: pending final PDF copy — keep this short version for the sandbox build.) |
| Cover | [USER: upload PDF cover page image — TODO agent: export page 1 of the v3 PDF as PNG ≈1500×2400] |
| Cover Video (optional) | https://www.youtube.com/watch?v=EyEwIrhGKoI (Duane's own video — ONLY wire after the data-use + likeness agreement is signed; leave image cover in sandbox) |
| Gallery (0-10) | [agent TODO: 3 interior-page exports from the v3 PDF] |
| Feature list | + "The exact $500K instrument sequence, step by step" · + "Post-crash recovery playbook" · + "Real numbers from a real early retirement" · + "Instant PDF download, 80+ pages" |
| Price | $19.00 USD, one-time |
| Checkout | Hosted; thank-you redirect → https://expanpress.com/c/duane500k/ |

## C. Optional belt-and-braces: support@fungies.io / Discord question

> "Confirming seller onboarding for Egypt: your published Global Availability list includes
> Egypt (121 countries), and your payout table shows EGP settlement (min 20 EGP). We are a
> Cairo-based individual seller planning to connect our own Stripe account for payouts
> (Egyptian ID + EGP bank). Anything to be aware of for Egypt-based sellers on Stripe Connect
> payouts through Fungies?"

## D. Open items

- [USER] activation form fields marked [USER: …]
- [USER] product form: sign-off on Name/Description/Feature list wording
- [agent] cover image + gallery exports from the v3 PDF (pending PDF polish round 4)
- [agent] Fungies API catalog build once a sandbox API key exists (products, prices, upsell
  options where API supports)
- [gate] publish NOTHING live until Duane signs the data-use + revenue-split agreement
