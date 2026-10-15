# 0061 — Dedicated Payment Domain: pay.expanpress.com as the Sole Provider-Agnostic Checkout Origin

**Status:** Accepted (domain and routing rules); the books URL key is still open (see Decision 4)
**Date:** 2026-10-15
**Supersedes:** — (the earlier practice of linking Buy buttons to `/api/billing/checkout` on the main site)
**Superseded-by:** —

## Context

Payment providers review the URL they approve. Paddle (and any other rail) asks for a checkout domain and a pricing URL. Until now, Buy buttons lived on `expanpress.com` under `/c/{handle}/{product}`, and provider submissions would have named the marketing domain. Changing providers would then mean changing the domain each provider approved, and the marketing site would load whatever provider code the checkout needs. A single checkout origin keeps the provider-facing surface fixed while rails change behind it. The founder decided this on 2026-10-15 and asked that it be recorded as an ADR; the decision record is the founder's statement in that session.

## Decision

1. **`pay.expanpress.com` is the only checkout origin.** It is the one domain submitted to every payment provider that reviews URLs. Submitting `expanpress.com` as the checkout domain is forbidden. Provider submissions wait until `pay.expanpress.com` is live.
2. **Provider SDKs and provider checkout code run only on `pay.expanpress.com`.** No provider SDK may be imported or loaded by a page served from `expanpress.com`. Verified by a code inventory and by the red-team audit of 2026-10-15.
3. **Route shape on `pay.expanpress.com`:** `/checkout/{product-id}` renders product, price, a Buy button and a footer with Terms, Privacy, Refund Policy and the support email. It is not a bare redirect, because reviewers check the domain they approve and must see a real page. The Buy button starts the server-side checkout for the active rail. The footer's legal links point at the legal pages served on both domains.
4. **Books URL key (OPEN, founder decision needed).** Sales pages live at `expanpress.com/books/{key}`, and creator shelves at `/authors/{creator-slug}`. `/creators/` is not used because it collides with the creator portal at `/creator/signin`. The `{key}` cannot be the bare product slug: `products.slug` is unique only per creator (`UNIQUE (creator_id, slug)`), and the live data already has two products with slug `retirearly500k` under different creators. The key must be a globally unique value such as `composite_slug` (unique, but null on test rows) or `site_slug` (unique). The pricing URL in the Paddle form (`/books/retirearly500k`) must match the chosen key. Until the founder picks one, no `/books/` route ships.
5. **Legacy redirects.** `/c/{handle}` returns 301 to `/authors/{handle}`. `/c/{handle}/{product}` returns 301 to the `/books/{key}` form chosen under Decision 4. Redirects stay in place so existing links keep working.
6. **robots.** `expanpress.com`: published `/books/*` and `/authors/*` may be indexed; draft or unpublished titles get `noindex`. `pay.expanpress.com`: disallowed for all crawlers (`Disallow: /`), while its legal pages stay reachable by humans through the footer.
7. **Legal pages are served on both domains.** Terms, Privacy, Refund Policy and the providers page must return 200 on `expanpress.com` and `pay.expanpress.com`.

## Consequences / Tradeoffs

- Provider changes no longer require a new domain submission. The cost is one extra hop for buyers, and the checkout page must look trustworthy on its own because it is a separate origin.
- Any Buy link on `expanpress.com` must point to `pay.expanpress.com/checkout/{id}`. A Buy button that still points to `/api/billing/checkout` on the main site bypasses this ADR and is a finding.
- Standing rule: a new provider SDK is added only to the `pay.` build surface, and a PR that imports one elsewhere fails review.
- Known gap: providers currently in use are hosted-redirect checkouts, so no overlay SDK is loaded yet. "Loads the active provider overlay" from the founder's note is therefore not implemented in PR 2a. It is recorded here so the first overlay provider is held to Decision 2.
- Failure mode to watch: the `pay.` host must not be able to start a charge for a product whose consent gate is closed. The consent check stays on the server route (see ADR 0060), not on the page.

## Sources

- Founder decision record, session of 2026-10-15 (pasted from the Claude web planning thread): domain, route shape, `/books` and `/authors` naming, robots rules, Paddle form values.
- `web/src/components/storefront/storefront.tsx` (`productSlugOf`, `fetchStoreProduct`): current product lookup by creator handle plus slug.
- Live `hex-expan-press` schema, read-only, 2026-10-15: `products` unique constraints (`composite_slug`, `site_slug`, `(creator_id, slug)`); three product rows with two distinct slugs.
- ADR 0060 (universal consent enforcement at the checkout route).
