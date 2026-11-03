import { PolarAdapter } from "../../../../../src/adapters/payments/polar.adapter";
import { PaddleAdapter } from "../../../../../src/adapters/payments/paddle.adapter";
import { LegacyPaymentAdapterWrapper } from "../../../../../src/adapters/payments/legacy.adapter";
import { fungiesProvider } from "../../../../../payments/src/providers/fungies";
import { isEnabledPaymentProvider } from "../../../../../payments/src/settings_registry";

// Every provider with a reviewed verifier is built here. The launch switch (providers.json "enabled", or the
// inline defaults) decides which ones are offered a request. A switched-off provider's verifier is never offered
// a request, so its signature is not claimed and the request is refused as unverified, as an unknown provider is.
/** Every provider with a verifier here, switched on or not. */
export function allVerifiers() {
  return [new PolarAdapter(), new PaddleAdapter(), new LegacyPaymentAdapterWrapper(fungiesProvider)];
}

/** The verifiers offered a request: only those whose provider is switched on. */
export function routableVerifiers() {
  return allVerifiers().filter((a) => isEnabledPaymentProvider(a.providerName));
}

/** Names of providers that have a verifier. A rail for any other provider cannot be verified, so it must not take a buyer. */
export function verifiedProviderNames(): Set<string> {
  return new Set(allVerifiers().map((a) => a.providerName));
}
