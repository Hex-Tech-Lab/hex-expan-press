# 0053 — Next.js App Router Migration

**Status:** Accepted
**Date:** 2026-09-29
**Supersedes:** the pre-Next static/public-HTML site served by Vercel (`web/index.html` landing, `web/public/creator/*` pages) and the `web/api/*.ts` standalone serverless functions
**Superseded-by:** —

## Context

The production site began as legacy static HTML plus four standalone serverless functions placed under `web/api/`. Two failures forced the migration:

1. **Function shadowing (P0, 2026-09-29).** Vercel auto-discovered every file under `web/api/` as a standalone function, shadowing the Next `app/api` route handlers introduced in Wave 2. Because Wave 2's `web/package.json` had no `type` field, the legacy files' ESM output was parsed as CJS → `SyntaxError` → `FUNCTION_INVOCATION_FAILED` on every `/api/*` call (checkout returned 500 instead of 302; webhooks 500 instead of 400/200). Fixed by relocating the handlers to `web/_legacy_handlers/` so the Next route handlers solely own `/api/*` (commit 924e658, PR #2 merged as 044d276).
2. **A static-only production deployment.** The Vercel project's framework preset was `None`, so production never ran Next at all — it was pure static output plus api-dir functions. Fixed by setting the preset to `nextjs` with `rootDirectory: web` unchanged (commit 0ca17d4).

## Decision

1. **Next.js 16.3.3 lives in `web/` as a pnpm-workspace package** (commit 5298b1b; dependency pinned `"next": "16.3.3"` in `web/package.json`). React is 19.2.7. The repo root remains the pipeline workspace; `web/` is the only Next app.
2. **The App Router owns every URL surface.** Legacy HTML was ported page by page into route handlers/RSC and then deleted: landing (`app/page.tsx` replacing `public/index.html`, commit e59f05e), creator signin (commit e357dcb), creator dashboard (commit a5d29f6), review + consents + esign_done (commit d9f1df7, which also deleted the three `web/public/creator/*.html` files and the legacy rewrites).
3. **Server logic is native route handlers, never the legacy shim.** Wave 6 replaced the req/res shim bridge with native handlers for all four endpoints (`/api/billing/checkout`, `/api/billing/webhook`, `/api/esign/create`, `/api/esign/webhook`, commits 7138d67 → dbe8793), all declaring `export const runtime = "nodejs"`, then deleted `web/app/api/_legacy/shim.ts` and `web/_legacy_handlers/*` (commit dbe8793).
4. **URL-preserving redirects were temporary scaffolding only.** The `rewrites()` that mapped old public paths onto the new routes were deleted together with the legacy HTML in commit d9f1df7; the canonical routes are the App Router paths.

## Consequences / Tradeoffs

- **Easier:** one runtime (Node, not per-file Vercel functions), one build (`next build`), one gate set (web eslint → tsc → build → vitest) covering the whole surface.
- **Easier:** Server Components + Server Actions keep auth tokens server-side; the legacy client-side `auth-bridge` and `auth-bridge-core.ts` were deleted in Wave 5 (commit e357dcb).
- **Harder:** Next's bundler must be able to trace every file the webhook route needs — `payments/config.*.json` had to be bundled explicitly via `outputFileTracingIncludes` (commit facaf0c, CodeRabbit Major finding) and the Turbopack tracer needed an env-gated `PAYMENTS_CONFIG_DIR` path in `loadProductIndex` (commit 5298b1b).
- **Accepted cost:** the legacy static HTML is gone; any future page must be an RSC/route handler, never a dropped-in HTML file.

## Sources

- `git log --since=2026-09-25` commits 5298b1b, 924e658, 0ca17d4, e59f05e, e357dcb, a5d29f6, 7138d67, dbe8793, d9f1df7
- `web/package.json` (next 16.3.3, react 19.2.7, no `type` field pre-fix)
- `web/app/api/*/route.ts` (`export const runtime = "nodejs"` on all four handlers)
- `web/next.config.ts` (outputFileTracingIncludes / outputFileTracingRoot)
