# 0055 — Edge/Node Runtime Boundary in the App Router

**Status:** Accepted
**Date:** 2026-09-28
**Supersedes:** the pre-Next practice of letting Vercel auto-discover `web/api/*.ts` as standalone functions with whatever runtime the file implied
**Superseded-by:** —

## Context

Wave 6 moved all four API endpoints into native Next route handlers (`web/app/api/billing/checkout/route.ts`, `web/app/api/billing/webhook/route.ts`, `web/app/api/esign/create/route.ts`, `web/app/api/esign/webhook/route.ts`; commits 7138d67, dbe8793). Two constraints forced an explicit runtime boundary rather than Vercel's default:

1. **Node-only dependencies in the hot path.** The billing webhook reads the raw body through a `Buffer` reader (byte-exact HMAC verification requires it — the Wave 6 route test proves multi-byte UTF-8 survives byte-exactly, commit 3cbf6f4) and persists via the payments ledger on the Node filesystem (`payments/src/ledger.ts` uses `node:fs` with a `/tmp` redirect on serverless, `resolveSalesFile`). Buffer and node:fs are unavailable on the Edge runtime.
2. **Middleware must stay edge-light.** `web/middleware.ts` runs `getUser()` on every creator-portal request for token refresh (ADR-0054); it imports only `next/server` and `@supabase/ssr`, no Node builtins.

## Decision

1. **All four API route handlers declare `export const runtime = "nodejs"` explicitly.** Verified in all four files (`web/app/api/*/route.ts`). Never rely on the platform default; the declaration is the contract.
2. **The Node runtime surface owns the ledger and HMAC verification.** Raw-body capped reads (`MAX_BODY_BYTES = 1_048_576` in the esign webhook, mirroring the billing webhook's 1 MiB Wave 4 contract), HMAC signature verification, JSONL ledger appends, and the Supabase dual-write all run only inside Node-runtime handlers.
3. **The Edge surface owns cookie/header manipulation only.** Middleware refreshes session cookies (the only legal `Set-Cookie` point in Next.js — RSC `set()` is ignored during render, commit 1018fcf) and performs no filesystem, no ledger, no signature work.
4. **Body handling in Node handlers streams and caps mid-read** (413 before buffering) so oversized POSTs cannot buffer in memory (commit 3cbf6f4, PR #1 review round 2).

## Consequences / Tradeoffs

- **Easier:** the webhook hot path keeps full Node API access without polyfills; the ledger's file+Supabase dual-write works unchanged on Vercel functions.
- **Harder:** any new route that touches `node:fs`, `Buffer`, or the ledger must also declare the Node runtime — forgetting it produces a build-time or cold-start failure instead of a silent wrong-runtime deployment.
- **Accepted cost:** middleware stays limited to cookie/header work; heavier per-request logic must live in Node handlers or RSC.
- **Standing rule:** never move HMAC verification or ledger writes onto the Edge runtime to "save cold start"; the byte-exactness and filesystem contracts come first.

## Sources

- `git log --since=2026-09-25` commits 5298b1b, facaf0c, 3cbf6f4, 7138d67, dbe8793, 1018fcf
- `web/app/api/billing/webhook/route.ts` and `web/app/api/esign/webhook/route.ts` (`export const runtime = "nodejs"`; MAX_BODY_BYTES comment)
- `payments/src/ledger.ts` (`resolveSalesFile` — `/tmp` redirect on Vercel/Lambda)
- `web/middleware.ts` (refresh-boundary header comment)
