# 0057 — Webhook Idempotency and Fail-Closed Financial Writes

**Status:** Accepted
**Date:** 2026-09-29
**Supersedes:** — (extends ADR-0050's ledger idempotency guard and the 2026-09-22 SETNX lock introduced in commit af11ea1)
**Superseded-by:** —

## Context

Payment providers retry aggressively and serverless invocations run concurrently, so every financial write path must be idempotent and every persistence failure must be visible to the retrying provider. Three verified gaps existed after Wave 6.1:

1. **The use-case path had no distributed lock.** `processBillingWebhookUseCase` guarded duplicates only with `findSaleAsync` (read-then-write) and called `appendRefund` bare. The SETNX idempotency lock existed only inside `payments/src/webhook_core.ts`'s `recordSale`/`recordRefund` (commit af11ea1: "closed a real TOCTOU race... concurrent webhook deliveries could both pass the file-based duplicate check before either has appended, producing a double creator payout").
2. **The Supabase dual-write swallowed failures.** `persistToSupabaseOrder` logged `console.error` on upsert error/exception and returned normally (introduced commit 2ba5d80, migration `20260927000200_orders_ledger.sql` with `unique (provider, sale_id, event_type)`), so the webhook route replied 200 and the provider never retried — the permanent `public.orders` record could silently lag the JSONL ledger.
3. **A duplicate refund threw.** `appendRefund`'s idempotency guard raised `ledger: refund already recorded...` on any second delivery; and the duplicate check only consulted the local JSONL file, never `public.orders`.

## Decision (post-fix state, Wave 6.2 P1)

1. **The distributed lock is the shared primitive.** `withIdempotencyLock` is exported from `payments/src/webhook_core.ts` (Upstash SETNX with `WEBHOOK_LOCK_TTL_SECONDS = 300`; no-op when `UPSTASH_REDIS_REST_URL`/`TOKEN` are unconfigured; frees the slot when the wrapped fn reports `recorded: false` or throws). `src/use_cases/billing/process_billing_webhook.ts` wraps BOTH paths in it with keys **`sale:<provider>:<saleId>`** and **`refund:<provider>:<saleId>`** — refund events carry only `saleId` (the domain port's `RefundIssuedEvent` has no independent refund id), so no refund id is invented.
2. **Record exists → 200; lock merely held → 503 (amended Wave 7, 2026-09-29).** A held lock is not success: the holder may still fail its write. `withIdempotencyLock` throws `WebhookInFlightError` when it cannot acquire the lock; the use case then checks the durable store (`findSaleAsync` / `findRefundAsync`) and acknowledges only if the record already exists. Otherwise the error propagates and the webhook route answers **503 with `Retry-After: 30`** so the provider redelivers. (The legacy `recordSale`/`recordRefund`/`handleWebhookPayload` handlers, which mapped the same condition to 503, had no callers and were removed in Sprint 11.) Inside the lock, the existing duplicate checks still short-circuit true duplicates with `reason: "duplicate"`.
3. **Supabase dual-write is fail-closed.** When `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are both set, `persistToSupabaseOrder` **throws** on upsert error or exception (`ledger: Supabase orders upsert failed: ...` / `ledger: Supabase dual-write failed: ...`); the use case propagates, the webhook route returns 500, and the provider retries. When the env is unset the function stays a no-op (local/test runs unchanged).
4. **Duplicate refunds resolve, never throw.** `appendRefund` returns the already-recorded refund record instead of raising. The duplicate check consults the local file first (`findRefund`) and then `public.orders` via the new `findRefundAsync` (query: `provider`, `sale_id`, `event_type = 'refund'`, `maybeSingle()`) whenever Supabase is configured — closing the file/DB divergence window.
5. **Auth origin allow-list (same wave, adjacent hardening).** `resolveOrigin()` in `web/app/creator/signin/actions.ts` in production now trusts the request host (`x-forwarded-host`/`host`, first comma-separated entry, trimmed, lowercased) ONLY when it is in the allow-list — `expanpress.com`, `www.expanpress.com`, plus hosts from a comma-separated `ALLOWED_AUTH_HOSTS` env var (read at call time); otherwise it falls back to `NEXT_PUBLIC_SITE_ORIGIN ?? https://expanpress.com`. Production origins are always `https://`. The stale `void headers;` line in `signInWithGoogleAction` is deleted. This closes the spoofed-Host steering vector on the OAuth round-trip while keeping the preview/local request-scoped behavior of commit dd7925e intact.
6. **Observability defaults.** `web/app/error.tsx` captures route-boundary errors (`useEffect(() => { Sentry.captureException(error) }, [error])` with `import * as Sentry from "@sentry/nextjs"`); `web/app/creator/dashboard/page.tsx` uses the namespace import (`import * as Sentry`); the esign webhook takes the first comma-separated, trimmed entry of `x-forwarded-for` as the consent-record IP, falling back to `0.0.0.0`.

## Consequences / Tradeoffs

- **Easier:** one lock primitive guards every financial write path regardless of which layer receives the webhook; a Supabase outage can no longer silently desynchronize `public.orders` from the JSONL ledger.
- **Harder:** with Supabase configured, a dual-write failure now fails the webhook (500) — the provider retries until both stores agree. This is the intended fail-closed posture for money.
- **Accepted cost:** refund idempotency keys on `sale_id` alone; a provider that can refund the same sale twice through distinct refund events cannot be modeled — refunds remain full reversals (per ADR-0050), and partial-refund events (refund `totalCents` below the original sale) are rejected by the billing use case as a validation failure (400) and logged for manual handling (Wave 7).
- **Standing rule:** any new financial write path must run inside `withIdempotencyLock` with a `<type>:<provider>:<saleId>`-shaped key, and any new permanent store must either fail closed or be provably derivable from a store that does.

## Sources

- `git log --since=2026-09-25` commits af11ea1 (SETNX lock origin), 2ba5d80 (orders ledger dual-write + findSaleAsync), d9f1df7 (Wave 6.1), plus the uncommitted Wave 6.2 P1/P2 diff on `feature/wave62-webhook-idempotency`
- `payments/src/webhook_core.ts` (exported `withIdempotencyLock`, TTL 300, recorded:false release)
- `src/use_cases/billing/process_billing_webhook.ts` (sale/refund lock keys, duplicate responses)
- `payments/src/ledger.ts` (fail-closed `persistToSupabaseOrder`, resolving `appendRefund`, `findRefundAsync`)
- `supabase/migrations/20260927000200_orders_ledger.sql` (`unique (provider, sale_id, event_type)`)
- `web/app/creator/signin/actions.ts` (production host allow-list)
- `web/app/error.tsx`, `web/app/creator/dashboard/page.tsx`, `web/app/api/esign/webhook/route.ts`
