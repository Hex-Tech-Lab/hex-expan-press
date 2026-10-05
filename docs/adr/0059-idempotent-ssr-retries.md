# 0059 — Idempotent-Only Skew Retries in Supabase SSR Clients

**Status:** Accepted
**Date:** 2026-10-05
**Supersedes:** — (narrows the sprint-12 B2 skew-retry wiring, which retried any method on 401 PGRST303)
**Superseded-by:** —

## Context

The creator portal's Supabase clients (`web/src/lib/supabase-ssr.ts`, `web/src/lib/supabase-server.ts`) wrap their fetch with `createSkewRetryFetch`: a freshly minted JWT whose `iat` sits a few seconds in the future (Vercel↔Supabase clock drift) fails PostgREST/Auth with 401 PGRST303, and a single delayed retry absorbs it. Sprint 12 wired this wrapper to ALL client traffic, and the on-record safety argument was: *PGRST303 is rejected at the JWT-verification layer before any transaction begins, so the first attempt can never have committed — retrying mutations is safe.*

That argument is behavioral: it holds for PostgREST's current response ordering and breaks silently if a version change, proxy layer, or different error path (e.g. a GoTrue-issued 401 with the same JSON shape, or an infrastructure-layer 401) ever reaches a mutation after side effects began. Under the Zero-Trust posture a retry of a non-idempotent request (PKCE code exchange, auth token rotation, any PostgREST write) is a replay risk that must be structurally impossible, not argued away.

## Decision

1. **The retry is gated to GET and HEAD inside `createSkewRetryFetch` itself.** Any other method (POST, PATCH, PUT, DELETE — regardless of case) is returned untouched on ANY 401, including an exact PGRST303 skew body. No call site can opt back in.
2. **The method is resolved from both `init.method` and a `Request`-object `input`** (normalized uppercase), defaulting to GET only when neither carries a method.
3. **The existing guards stay:** at most one retry, only on the PGRST303/"JWT issued at future" JSON shape, never on ReadableStream bodies, never on any other 401/status.
4. **Both SSR client factories inherit the gate unchanged** — the gate lives in the shared wrapper, so `supabase-ssr.ts` and `supabase-server.ts` need no per-site logic.

## Consequences / Tradeoffs

- **Easier:** the mutation-replay class of failure is closed by construction; the correctness of retries no longer depends on PostgREST's internal ordering of JWT verification vs. transaction start.
- **Harder:** a genuine skew 401 on a mutation is no longer auto-healed — the caller's operation fails once and the user retries the action. Accepted: the skew window is seconds wide, sign-in reads (GET) still self-heal, and a failed mutation is visible instead of silently duplicated.
- **Accepted cost:** if Supabase ever moves the skew 401 onto an idempotency-critical path that is not GET/HEAD (none exists today), the gate must be revisited explicitly via a new ADR — not by loosening the Set.
- **Standing rule:** any new retry wrapper on client traffic must be method-gated to idempotent verbs by default; widening it requires an ADR.

## Sources

- `web/src/lib/skew-retry-fetch.ts` (gate implementation: `IDEMPOTENT_METHODS`, `requestMethod`)
- `web/src/lib/__tests__/skew-retry-fetch.test.ts` (15 tests incl. POST/PATCH/PUT/DELETE non-retry, Request-object method, HEAD retry, lowercase normalization)
- `web/src/lib/supabase-ssr.ts`, `web/src/lib/supabase-server.ts` (the two wired client factories)
- `payments/src/settings_registry.ts` (`jwtSkewRetryDelayMs`)
