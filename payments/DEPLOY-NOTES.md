# Deploy Notes — expan-payments (payments/site/)

**Deployed: 2026-09-15** via Vercel CLI (account `techhypexp`, project `expan-payments`).

## Live URL

- **Production (clean alias): https://expanpress.com** (canonical since 2026-09-15; www.expanpress.com aliases the same deployment; https://expan-payments.vercel.app remains a working fallback)
- **DNS (Namecheap panel, registrar nameservers kept):** `A @ 76.76.21.21` + `CNAME www → cname.vercel-dns.com` (set 2026-09-15; cert issuance auto-completes after). Email forwarding: Namecheap free forward `support@ → <real inbox>` (MX auto-set by the panel).
- Run-scoped: https://expan-payments-duxtsh1cn-techhypexps-projects.vercel.app
- Dashboard: https://vercel.com/techhypexps-projects/expan-payments/AbZwXw78KkbSTxNsfEBaC1QGME9Q

All 4 pages verified HTTP 200 live: `/`, `/privacy.html`, `/terms.html`, `/refund-policy.html`.
Static deploy, zero build step, self-contained CSS, no external fonts/scripts.

## Files

| File | Purpose |
|---|---|
| `index.html` | Master product landing (public-facing): title, $19, GATED buy button, what's inside, disclaimers |
| `c/retirearly500k/500k-playbook/index.html` | Per-product page for Duane's base playbook (URL subpath `/c/retirearly500k/500k-playbook/` — NESTED under the creator's own directory since 2026-09-16, when the hub page shipped; the composite `retirearly500k-500k-playbook` is the Fungies/Polar internalId namespace only, never a URL path, per slug_rule in config.duane.json — single-domain /c/-subpath ADR, never subdomains): same design language, creator byline, gated primary button + clearly-labeled SANDBOX TEST checkout link, OG/twitter meta + canonical to `https://expanpress.com/c/retirearly500k/500k-playbook/`. Serves automatically as a static subdir — no vercel.json redirects needed (none exist; legacy naming mistakes are fixed at the source, never redirected — the old flat `/c/retirearly500k-500k-playbook/` path 404s by design) |
| `c/retirearly500k/index.html` | **Creator hub page** for Duane (URL subpath `/c/retirearly500k/`): creator name, platform handles (YouTube/IG), short bio, photo slot (currently a monogram placeholder — no fabricated photos; real photo only after the creator agreement covers likeness rights, legal gate 2026-09-14), and one product card per product (typographic cover tile + title + price + working-title note) linking to its nested `/c/<handle>/<product-slug>/` page. NOT hand-written: baked from `../creators.json` by `../bake_creator_pages.ts` |
| `../creators.json` | Creators index — per-creator hub data (handle, display name, platform handles, bio + bio_source, photo, product list as `{composite_slug, product_slug, config_file}`). Adding a second creator = add an entry + re-run the hub baker; product title/price/working-title state is read from each referenced config at bake time (config stays the single source of truth) |
| `../bake_creator_pages.ts` | Hub baker — renders `site/c/<handle>/index.html` for every creator in `creators.json`; validates the composite-slug rule (every product's composite_slug must start with `<handle>-`) before writing |
| `privacy.html` | Privacy policy (individual seller, Egypt; email-only collection; payment partners generic) |
| `terms.html` | Terms of service (personal-use PDF license, not-financial-advice, Egypt governing law) |
| `refund-policy.html` | 14-day refund window / not-as-described, processed via payment partners |
| `../config.duane.json` | Source of truth for title/description/price/creator + `checkout_url`/`checkout_mode` (see bake contract below) |
| `../bake_checkout.ts` | Button baker — rewrites the `data-checkout-slot` anchors from config (run after ANY config change, before deploy) and bakes the product→creator-hub back-link (breadcrumb) into every product page, resolved per-product from `../creators.json` |

## Buy-button bake contract (2026-09-16)

The static site has **no runtime fetch for the checkout target** — the resolved href is baked into the HTML as a plain `<a>`. Each baked anchor carries provenance: `data-checkout-slot="primary|sandbox"`, `data-config-source="payments/config.duane.json"`, `data-checkout-mode`, `data-baked-at`.

Source of truth: `payments/config.duane.json` → `checkout_url` + `checkout_mode` (`gated` | `sandbox` | `live`).

**Back-link bake (2026-09-16):** every product page gets a top-of-page breadcrumb `<nav class="crumb">` → `← Back to <display_name>'s page` linking to `/c/<handle>/` (two-way link with the hub's product card). Handle + display name + per-product config file come from `../creators.json` (`composite_slug` → creator), never hardcoded; a product page not mapped there logs a warn and gets no back-link. Re-runnable: strips the previous crumb and re-injects with a fresh `data-baked-at` (provenance: `data-creator-hub`).

| Page | Primary button | Sandbox link |
|---|---|---|
| `index.html` (master, public) | ALWAYS gated (disabled: "Checkout coming online — provider review in progress") — policy hard-coded in the baker | none |
| `c/retirearly500k/500k-playbook/index.html` | gated while `checkout_mode` ≠ `live`; becomes the real buy button at `checkout_mode: "live"` | shown only while `checkout_mode: "sandbox"`, labeled "test — sandbox — no real charge" |

**Re-bake after any config change, then redeploy:**

```bash
node_modules/.bin/tsx payments/bake_checkout.ts
node_modules/.bin/tsx payments/bake_creator_pages.ts   # re-bakes all /c/<handle>/ hub pages from creators.json
cd payments/site && ../../node_modules/.bin/vercel --prod --yes
```

**Before and after every deploy (blind-spot audit 2026-09-25):** `python3 scripts/live_site_check.py --local` before (must be 0 failing), `python3 scripts/live_site_check.py` after (checks live expanpress.com price/title against config, and that buy buttons stay gated until `checkout_mode: "live"`).

The two bakers are independent but both re-runnable: `bake_checkout.ts` touches only pages carrying `data-checkout-slot` anchors (master + per-product pages) and now **skips pages without checkout slots** (creator hub pages — they carry no checkout, only internal links to product pages, so the sandbox/gated policy never applies to them).

Current baked state (2026-09-16, `checkout_mode: "sandbox"`): sandbox link = `https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_g84ByoGAeZiahkWtCasYmeu1ShLtZIwwayzyI4ZdZsM/redirect` (resolves 307 → `sandbox.polar.sh/checkout/polar_c_…` session). Polar SANDBOX artifact ids, recorded in `config.duane.json`: product `f9376e27-13bf-4a88-9f73-cc1168ad2923`, checkout link `580f69a8-fc34-4118-9553-d83c6165fc00`.

**LEGAL GATE (2026-09-14, locked):** the store stays UNPUBLISHED and NO LIVE SELLING until the data-use + revenue-split agreement with Duane is signed. The sandbox link above never charges or fulfills — that is why it may ship publicly. Going live = flip `checkout_mode` to `"live"` with a real (non-sandbox) `checkout_url`, re-bake, redeploy, and only then publish the provider store.

## Honesty guardrails honored (Creem "no false info" gate)

- Buy button href is the literal placeholder `#buy-link-pending` — **no live checkout anywhere**; store stays unpublished until the creator signs (per `config.duane.json` working_note).
- Product marked as a **working title** on the page ("final title may change before publication").
- **No named creator, no testimonials, no reviews, no fabricated social proof.** Creator is referenced only as "the creator".
- **STANDING RULE (2026-09-16, user mandate): revenue-share terms and payout specifics are NEVER public-facing.** Split percentages, payout mechanics ("split automatically at checkout"), and deal status must not appear on any page served from `payments/site/`. This file lives OUTSIDE the web root for exactly that reason (it contains internal deal/provider-form terms).
- "Not financial advice" + "past performance" disclaimers present on index and in ToS §3.

## Provider review form answer sheet (paste-ready)

For Fungies "business details", Polar "Account Review", Creem review — identical details on all providers (`same_details_on_all_providers: true`):

| Field | Answer |
|---|---|
| Business type | Individual / Sole proprietor |
| Founder name | Kelly Bakri |
| Country | Egypt |
| Website | https://expan-payments.vercel.app |
| Support email | `[FILL: support email]` — **founder must set this** (also 7× in the site HTML) |
| Product category | Digital ebooks (PDF) — downloadable PDF guide |
| Product description | A practical money-management playbook for the retirement years: the instruments, the sequence, and the recovery playbook after a market crash — built on one early retiree's real $500K journey. Delivered as a downloadable PDF; not financial advice. |
| Monthly volume estimate | `[FILL: user]` — founder decision |
| Product price | $19 USD, one-time |
| Refund policy | 14-day window, full refund; not-as-described claims refunded within window; processed by provider |
| Revenue split | per the signed creator agreement (private terms file), automatic at checkout |

### Remaining founder FILLs (only the founder can decide)

1. **Support email** — `[FILL: support email]` (7 occurrences: index ×1, privacy ×3, terms ×1, refund ×2). Replace with the real support address, e.g. via a quick sed, then `vercel --prod --yes` from `payments/site/` to redeploy.
2. **Monthly volume estimate** — `[FILL: user]` (form answer only, not on the site).
3. Optional: legal/trade name (privacy §1, terms §1) and postal address (privacy §7) — currently marked `[FILL: legal / trade name if registered]` / `[FILL: postal address, optional per provider requirements]`; blank-as-individual is acceptable on most provider forms.

## Before going live for real (post-signature)

1. Rename product if the creator changes the title; update `config.duane.json` `title` + both landing pages' `<h1>` + `<title>`.
2. Flip `config.duane.json` `checkout_url` to the provider's live link + `checkout_mode: "live"` → run `tsx payments/bake_checkout.ts` (master `index.html` stays gated by policy — flipping it is a separate founder decision).
3. Set the real support email (see above) and redeploy.
4. Only then publish the provider store.

## Deploy commands (for reference)

```bash
cd payments/site
vercel link --yes --project expan-payments   # already done
vercel --prod --yes
```

Vercel auth used the existing CLI session (`vercel whoami` → `techhypexp`); no `VERCEL_TOKEN` in `.env` was needed. `payments/site/.vercel/` holds link settings and is gitignored via `payments/site/.gitignore`.
