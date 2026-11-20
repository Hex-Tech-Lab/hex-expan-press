import { PolarAdapter } from "../../../../../src/adapters/payments/polar.adapter";
import { PaddleAdapter } from "../../../../../src/adapters/payments/paddle.adapter";
import { CreemAdapter } from "../../../../../src/adapters/payments/creem.adapter";
import { LegacyPaymentAdapterWrapper } from "../../../../../src/adapters/payments/legacy.adapter";
import type { PaymentProviderPort } from "../../../../../src/domain/payments/payments.port";
import { fastspringProvider } from "../../../../../payments/src/providers/fastspring";
import { fungiesProvider } from "../../../../../payments/src/providers/fungies";
import { lemonsqueezyProvider } from "../../../../../payments/src/providers/lemonsqueezy";
import { payhipProvider } from "../../../../../payments/src/providers/payhip";
import {
  PAYMENT_PROVIDERS,
  isEnabledPaymentProvider,
  type PaymentProviderSetting,
} from "../../../../../payments/src/settings_registry";

const VERIFIER_FACTORIES: Record<string, () => PaymentProviderPort> = {
  polar: () => new PolarAdapter(),
  paddle: () => new PaddleAdapter(),
  creem: () => new CreemAdapter(),
  fungies: () => new LegacyPaymentAdapterWrapper(fungiesProvider),
  lemonsqueezy: () => new LegacyPaymentAdapterWrapper(lemonsqueezyProvider),
  payhip: () => new LegacyPaymentAdapterWrapper(payhipProvider),
  fastspring: () => new LegacyPaymentAdapterWrapper(fastspringProvider),
};

// Every registered provider with a reviewed verifier is instantiated from PAYMENT_PROVIDERS. The launch switch
// (providers.json "enabled", or the inline defaults) decides which ones are offered a request. A switched-off
// provider's verifier is offered a request only to recognise a signed delivery for manual-review recording.
/** Builds webhook verifier adapters for every registered provider in `providers` (defaults to `PAYMENT_PROVIDERS`). */
export function buildWebhookVerifiers(
  providers: Record<string, PaymentProviderSetting> = PAYMENT_PROVIDERS,
): PaymentProviderPort[] {
  const out: PaymentProviderPort[] = [];
  for (const name of Object.keys(providers)) {
    const factory = VERIFIER_FACTORIES[name];
    if (factory) out.push(factory());
  }
  return out;
}

/** Every registered provider with a verifier here, switched on or not. */
export function allVerifiers() {
  return buildWebhookVerifiers();
}

/** The verifiers offered a request: only those whose provider is switched on. */
export function routableVerifiers() {
  return buildWebhookVerifiers().filter((a) => isEnabledPaymentProvider(a.providerName));
}

/** Verifiers for switched-off providers. Used only to recognise a signed delivery for a switched-off rail, so it is
 *  recorded for manual review instead of vanishing. Never used to process a sale. */
export function switchedOffVerifiers() {
  return buildWebhookVerifiers().filter((a) => !isEnabledPaymentProvider(a.providerName));
}

/** Names of providers that have a verifier. A rail for any other provider cannot be verified, so it must not take a buyer. */
export function verifiedProviderNames(): Set<string> {
  return new Set(buildWebhookVerifiers().map((a) => a.providerName));
}
