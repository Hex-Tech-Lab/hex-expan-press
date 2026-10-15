# 0061 — Dedicated Payment Domain: pay.expanpress.com as the Sole Provider-Agnostic Checkout Origin

**Status:** Accepted (2026-10-15, founder decisions incl. URL form in Decision 4)
**Date:** 2026-10-15
**Supersedes:** — (the earlier practice of linking Buy buttons to `/api/billing/checkout` on the main site)
**Superseded-by:** —

## Context

Payment providers review the URL they approve. Paddle (and any other rail) asks for a checkout domain and a pricing URL. Until now, Buy buttons lived on `expanpress.com` under `/c/{handle}/{product}`, and provider submissions would have named the marketing domain. Changing providers would then mean changing the domain each provider approved, and the marketing site would load whatever provider code the checkout needs. A single checkout origin keeps the provider-facing surface fixed while rails change behind it. The founder decided this on 2026-10-15 and asked that it be recorded as an ADR; the decision record is the founder's statement in that session.

## Decision

1. **`pay.expanpress.com` is the only checkout origin.** It is the one domain submitted to every payment provider that reviews URLs. Submitting `expanpress.com` as the checkout domain is forbidden. Provider submissions wait until `pay.expanpress.com` is live.
2. **Provider SDKs and provider checkout code run only on `pay.expanpress.com`.** No provider SDK may be imported or loaded by a page served from `expanpress.com`. Verified by a code inventory and by the red-team audit of 2026-10-15.
3. **Route shape on `pay.expanpress.com`:** `/checkout/{product-uuid}` renders product, price, merchant-of-record line, a Buy button and a footer with Terms, Privacy, Refund Policy and the support email. It is a real page, not a redirect, because reviewers check the domain they approve. The Buy button calls the checkout route, which enforces consent and picks the rail. `proxy.ts` sends every other `pay.` path back to `expanpress.com`, except the legal pages, the checkout API and build assets. `expanpress.com` sends `/checkout/*` and `/api/billing/checkout` to `pay.`.
4. **URL form (decided 2026-10-15).** Sales pages are `expanpress.com/books/{creator}/{product}`, where `{product}` is the `site_slug` second segment. Creator shelves are `/books/{creator}`. There is no `/authors` route. `/creators/` is not used because it collides with the creator portal at `/creator/signin`. `products.slug` is unique only per creator (`UNIQUE (creator_id, slug)`), so the creator stays in the path. `site_slug` is globally unique (`UNIQUE (site_slug)`).
5. **Legacy redirects.** `/c/{creator}` returns 301 to `/books/{creator}`, and `/c/{creator}/{product}` returns 301 to `/books/{creator}/{product}`. They are configured in `web/next.config.ts`. Redirects stay in place so existing links keep working.
6. **robots.** `expanpress.com`: published `/books/*` may be indexed; drafts and unpublished titles get `noindex` (`storefrontRobots`). `/c/*` no longer carries a blanket `X-Robots-Tag` header. `pay.expanpress.com`: `Disallow: /` for all crawlers (`public/robots-pay.txt`, served by the proxy). Its legal pages stay reachable by humans through the footer.
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
