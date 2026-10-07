# 0060 — Universal Consent Enforcement at Edge and Action Boundaries

**Status:** Accepted  
**Date:** 2026-10-06  
**Supersedes:** —  
**Superseded-by:** —  

## Context

During the ARTAS v3 security sweep (Sprint 14), critical authorization bypass vectors were identified in the purchase and agreement workflows:
1. **The Checkout Route Bypass (V22):** Public buyers accessing `GET /api/billing/checkout?product=<slug>` received provider checkout URLs regardless of creator consent status. Consent validation previously resided solely within the static build/bake phase (`payments/bake_checkout.ts`). Any direct query, serverless route invocation, or deployment without a preceding bake permitted checkout execution for products lacking legally binding agreements.
2. **Server Action Prerequisite Bypass (V22):** `startPublisherAgreementAction` previously validated only consent kind `C2_release_approval` before minting a Firma publisher agreement envelope (`C3_revenue_split`). Server Actions are publicly exposed HTTP endpoints; invoking `startPublisherAgreementAction` directly allowed a creator or external caller to skip prerequisite consent `C1_data_accuracy`.
3. **Cross-Product Supersession Scope Leak:** Portal consent resolution previously evaluated supersession only within product-scoped slices, risking cases where a superseded consent row for an earlier product might improperly read as active.

Under Zero-Trust architecture, asynchronous build-time checks ("bake time") must never serve as the sole security boundary. Public endpoints and Server Actions must independently and deterministically enforce authorization and legal requirements at runtime.

## Decision

1. **Universal Runtime Consent Gate:**
   - Every public checkout route handler (`web/app/api/billing/checkout/route.ts`) must query the live database and cryptographically/logically verify the creator's complete consent chain before generating or redirecting to a payment rail URL.
   - For all commercial products, all three mandatory consent kinds—`C1_data_accuracy`, `C2_release_approval`, and `C3_revenue_split`—must possess active chain heads with decision `given`. Missing or superseded consents fail closed with `403 Forbidden`.

2. **Server Action Prerequisite Chain Enforcement:**
   - `startPublisherAgreementAction` (`web/app/creator/dashboard/actions.ts`) must verify that both `C1_data_accuracy` and `C2_release_approval` are actively `given` on the resolved primary product before invoking `createEsignEnvelopeUseCase`.
   - Any missing, refused, or superseded prerequisite consent triggers a fail-closed redirect with `?error=c2_required` and aborts envelope creation.

3. **Global Supersession Resolution Prior to Product Scoping:**
   - In `web/src/lib/consent-chain.ts`, `activeConsentKinds` must resolve the creator's *complete* supersession chain across all products first. Only candidate chain heads (un-superseded rows) are then filtered by the requested `productId`.
   - This prevents an old consent from being marked active when its successor belongs to another product.

4. **Path Traversal & Atomic Write Hardening:**
   - The `product` query parameter in `web/app/api/billing/checkout/route.ts` is strictly sanitized with `^[a-zA-Z0-9_-]{2,80}$` and rejected on directory traversal sequences (`..`, `/`, `\`).
   - `writeFileAtomicReal` in `payments/bake_checkout.ts` generates unpredictable temporary files using `randomBytes(12)` and exclusive creation flags (`wx`), eliminating predictable-PID symlink-following attacks.

## Consequences / Tradeoffs

- **Security Posture:** Completely closes the gap between static bake artifacts and dynamic runtime endpoints. Zero commercial transactions can occur without active, verified creator agreements.
- **Fail-Closed Behavior:** If Supabase is unconfigured or encounters query errors during checkout, the route fails closed with a controlled 500 error rather than allowing unverified checkouts.
- **Performance:** Checkout URL generation adds a lightweight indexed query to `products` and `consents`. With standard indexing on `products.slug` and `consents.product_id`, latency impact is sub-millisecond and acceptable for checkout initialization.
- **Standing Rule:** No public-facing API route, Server Action, or billing rail may rely solely on async bake artifacts or client assertions. Every runtime entrypoint must verify prerequisite chains at the Edge/Action boundary.

## Sources

- `web/app/api/billing/checkout/route.ts` (`SAFE_PRODUCT_RE`, `activeConsentKinds` gate)
- `web/app/api/billing/checkout/__tests__/route.test.ts` (unit tests proving 403 Forbidden on missing/refused consents and 400 on traversal)
- `web/app/creator/dashboard/actions.ts` (`startPublisherAgreementAction` verifying C1 + C2)
- `web/app/creator/dashboard/__tests__/actions.test.ts` (unit tests proving fail-closed redirection when C1 or C2 is missing/refused)
- `web/src/lib/consent-chain.ts` (creator-wide supersession resolution)
- `web/src/lib/__tests__/consent-chain.test.ts` (cross-product supersession tests)
- `payments/bake_checkout.ts` (`writeFileAtomicReal` with cryptographic random suffix)
