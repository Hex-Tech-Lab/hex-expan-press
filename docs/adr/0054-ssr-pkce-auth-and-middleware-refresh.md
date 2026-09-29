# 0054 — SSR PKCE Auth and Middleware Token-Refresh Boundary

**Status:** Accepted
**Date:** 2026-09-29
**Supersedes:** the Wave 4 AuthBridge cookie-bridge flow (`web/app/creator/dashboard/auth-bridge.tsx`, `web/src/lib/auth-bridge-core.ts`, both deleted in commit e357dcb)
**Superseded-by:** —

## Context

The portal needs Google OAuth and email OTP sessions that never expose tokens to client JS. Two verified defects shaped the decision:

1. **@supabase/ssr default is `httpOnly: false`** — verified in the package's `constants.js` at version 0.12.7 (commit 6ad4e48). Relying on the default would have shipped JS-readable tokens, the exact vulnerability Wave 5 targets.
2. **PKCE verifier loss to domain hopping (P0, 2026-09-29, founder report).** `resolveOrigin()` preferred `NEXT_PUBLIC_SITE_ORIGIN`; on previews the returned redirect pointed Google at a host other than the one holding the HttpOnly verifier cookie, and the exchange failed as "Sign-in link expired or already used" (commit dd7925e, PR #7 merged as e2c4aa1).

## Decision

1. **All auth is server-side.** `web/src/lib/supabase-ssr.ts` creates the SSR client inside a Server Action/route-handler context and writes session cookies itself with EXPLICIT options: `httpOnly: true` always, `secure` in production, `SameSite=Lax`. The ssr client's `setAll` is the only cookie write path; `web/src/lib/supabase-server.ts` (used by RSC pages) is read-only — its `setAll` was removed in commit 1018fcf.
2. **PKCE everywhere.** `signInWithOAuth({ provider: "google" })` and `signInWithOtp` both go through the ssr client so the verifier lives in an HttpOnly cookie; no hash/implicit flow, no token in the fragment. The callback route (`web/app/auth/callback/route.ts`) performs the code exchange and strips URL fragments on error redirects (commit 1018fcf).
3. **Middleware is the only legal token-refresh point.** Server Components cannot mutate cookies (`next/headers` `set()` is ignored during RSC render), so `web/middleware.ts` runs `getUser()` — network validation, never local `getSession()` trust — on creator-portal routes and appends the refreshed `Set-Cookie` headers to the response. Refresh is fail-open (page still renders) but page-level auth redirects stay fail-closed; env gaps in middleware/callback fail closed instead of 500ing (commit 272fae3).
4. **Origin resolution is request-scoped outside production and pinned inside it.** After the P0 fix (commit dd7925e), `resolveOrigin()` returns the request host (`x-forwarded-host`/`host`, with `x-forwarded-proto`) for previews/local so the verifier cookie's host matches the OAuth return host, and pins `NEXT_PUBLIC_SITE_ORIGIN ?? https://expanpress.com` strictly when `VERCEL_ENV === "production"`. (Wave 6.2 additionally allow-lists the production request host — see ADR-0054's auth hardening entry; the allow-list change is uncommitted work-in-progress on `feature/wave62-webhook-idempotency` at the time of writing.)

## Consequences / Tradeoffs

- **Easier:** zero tokens in `localStorage`; the e2e scripts added in commit 1018fcf (`scripts/e2e-auth.mjs`, `scripts/e2e-otp-roundtrip.mjs`) live-proved Google PKCE initiation, HttpOnly SameSite=Lax verifier cookie on a real `Set-Cookie`, and zero localStorage tokens.
- **Harder:** every cookie write must happen in a Server Action, route handler, or middleware — an RSC render cannot persist a refreshed session, which is why middleware exists at all.
- **Accepted cost:** middleware runs `getUser()` per creator-portal request (a network round-trip) to keep the session fresh.
- **Standing rule:** never remove the explicit cookie options in `supabase-ssr.ts` or `middleware.ts`; the library default is `httpOnly: false` and silently regresses.

## Sources

- `git log --since=2026-09-25` commits 6ad4e48, e357dcb, 1018fcf, 272fae3, dd7925e
- `web/src/lib/supabase-ssr.ts` (explicit httpOnly comment, v0.12.7 constants.js reference)
- `web/middleware.ts` (refresh-boundary header comment, getUser validation)
- `web/app/creator/signin/actions.ts` (resolveOrigin production pin + preview request-scope)
