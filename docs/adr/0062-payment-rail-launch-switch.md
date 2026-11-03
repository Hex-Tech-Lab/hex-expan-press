# 0062 — Payment Rail Launch Switch: Rails Stay Defined, Enabled by Settings

**Status:** Accepted
**Date:** 2026-11-03
**Supersedes:** The practice of deleting a payment rail from the code to turn it off (Polar removal from routing in PR 102, deleted in commits `3ea973e` and `3bd287e`, 2026-10-16)
**Superseded-by:** —

## Context

Each payment rail is a provider adapter, a webhook verifier, a settings entry and a set of tests. Turning a rail off by deleting it also deleted its verifier, its route and its tests, so restoring it meant rebuilding all of them. The removal also left residue in the shared provider type and in webhook matching. Checkout dropped rows by provider name, so turning a rail on needed a code change in checkout as well as a setting. A webhook verifier is also the only way a delivery from a provider can be checked, so a rail with no verifier cannot safely take a buyer.

## Decision

1. **Every payment rail stays defined.** The rails `paddle`, `polar`, `fungies`, `lemonsqueezy`, `payhip` and `fastspring` are defined in `DEFAULT_PAYMENT_PROVIDERS` in `payments/src/settings_registry.ts`, and each rail with a verifier keeps it. Removing a rail's code is never a way to switch it off. Switching off is `enabled: false`.
2. **`enabled` is read fail-closed.** A missing or non-boolean `enabled` is off, and the loader logs the error. A `providers.json` that exists but cannot be parsed, or has no usable `payments` section, switches every rail off. A missing `providers.json` falls back to the inline defaults in `payments/src/settings_registry.ts`.
3. **Launch state (inline defaults).** `paddle` is `enabled: true`, the one rail offered to buyers at launch. `polar` is `enabled: false` but fully wired. `fungies` is `enabled: false` until it is approved as a launch rail (decision of 2026-11-03). `lemonsqueezy`, `payhip` and `fastspring` are `enabled: false`.
4. **Webhook routing honours the switch.** Only verifiers whose provider is switched on are offered a request (`routableVerifiers()` in `web/app/api/billing/webhook/verifiers.ts`). A delivery that no offered verifier claims is refused with 400, is not quarantined, and writes no `audit_log` row (`src/use_cases/billing/process_billing_webhook.ts`).
5. **Checkout honours the switch and the verifier list.** Checkout offers a rail only when its provider is switched on AND has a verifier (`verifiedProviderNames()`), in `web/app/api/billing/checkout/route.ts`. A product whose only active rails are switched off is refused with 404 ("Checkout is disabled").
6. **Signed deliveries for a switched-off rail (target, not yet implemented).** A signed delivery for a switched-off rail is refused with 400 and must be recorded for manual review under the audit event `WEBHOOK_PROVIDER_SWITCHED_OFF`, shown in the admin review queue. An unsigned or badly signed delivery is refused and writes no row. Current code refuses the delivery and writes no row; the `WEBHOOK_PROVIDER_SWITCHED_OFF` record does not exist yet.
7. **Pending or failed Polar refunds (target, not yet implemented).** The Polar adapter accepts only refunds with `status: "succeeded"`, and only those reverse the creator split. A pending or failed refund is rejected by schema validation (400) today. The decided behaviour is that such a refund is written to the manual-review queue as `MANUAL_REVIEW_REQUIRED_REFUND`, not refused without a record. That routing is not yet implemented.
8. **Adding and switching rails.** Adding a rail requires a provider adapter, a verifier, a registry entry and tests. Turning a rail on or off is a settings change, subject to rules 5 and 7 and, for Polar, to the checklist in rule 9. Several rails may be on at once. They may run in parallel (several rails offered together) and as fallbacks for each other. Which rails are offered is decided by the `enabled` flags together with the verifier requirement in rule 5.
9. **Pre-flip checklist for Polar.** `polar` must not be set to `enabled: true` until every item below is done. Status is recorded as of this ADR; no item is done.
   1. Verify the Polar refund payload shape against a real refund in the Polar sandbox. Status: open. Needs owner approval before a sandbox refund is created.
   2. Confirm `refund.updated` handling is not needed, or add it. Status: open. The adapter accepts only `refund.created` today, and pending refunds are not yet routed to manual review (rule 7).
   3. Confirm `WEBHOOK_PROVIDER_SWITCHED_OFF` rows appear in the admin review queue. Status: open. The event is not implemented (rule 6).
   4. Confirm `POLAR_WEBHOOK_SECRET` and `POLAR_ACCESS_TOKEN` are set in the target environment. Status: open.
   5. Run the switch-on tests (`payments/test/provider_launch_switch.test.ts`, `payments/test/providers_loader.test.ts`, `web/app/api/billing/webhook/__tests__/verifiers.test.ts`, and the Polar adapter tests). Status: open.

## Consequences / Tradeoffs

- Switching a rail on or off is a settings change, and restoring a rail does not rebuild its adapter, verifier or tests. The cost is that switched-off rails stay in the code and must be kept compiling and tested.
- A switched-off rail is never offered a request and never offered to a buyer, so an off setting is the enforced state, not a convention.
- A malformed `providers.json` turns every rail off, which stops checkout for every rail. This is deliberate. An operator who sees checkout disabled must check the `[settings-registry]` error log, not assume the file is missing.
- The Polar signature check is verified against the provider's documented scheme, not against a live signed delivery. This is recorded in `payments/README.md` and is not closed by this ADR.
- Standing rule: a pull request that deletes a rail's verifier, route or tests to switch it off fails review. Turning a rail off is `enabled: false`.
- Standing rule: a new rail is added only with the four parts in rule 8. A rail without a verifier must not take a buyer, and rule 5 enforces this in checkout.
- Failure mode to watch: rules 6 and 7 describe behaviour that is not yet in the code. Until they are, a switched-off delivery is refused without a manual-review record, and a pending Polar refund is rejected without one. Do not enable Polar before the checklist in rule 9 is complete.

## Sources

- `payments/src/settings_registry.ts` (`DEFAULT_PAYMENT_PROVIDERS`, `loadPaymentProviders`, `isEnabledPaymentProvider`): the inline defaults and the fail-closed loader.
- `web/app/api/billing/webhook/verifiers.ts` (`allVerifiers`, `routableVerifiers`, `verifiedProviderNames`): the verifier list and the two gates.
- `web/app/api/billing/checkout/route.ts` (rail filter and the 404 disable guard): the checkout gate.
- `src/use_cases/billing/process_billing_webhook.ts` (no-verifier refusal, `senderVerified = false`): the unverified-delivery path.
- `src/adapters/payments/polar.adapter.ts` (`PolarRefundSchema`, `status: "succeeded"`): the Polar refund rule.
- `payments/test/provider_launch_switch.test.ts`, `payments/test/providers_loader.test.ts`, `web/app/api/billing/webhook/__tests__/verifiers.test.ts`: the switch tests.
- ADR 0060 (universal consent enforcement at the checkout route) and ADR 0061 (`pay.expanpress.com` as the sole checkout origin), which this ADR does not change.
