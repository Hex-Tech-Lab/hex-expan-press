import { PolarAdapter } from "../../../../../src/adapters/payments/polar.adapter";
import { PaddleAdapter } from "../../../../../src/adapters/payments/paddle.adapter";
import { LegacyPaymentAdapterWrapper } from "../../../../../src/adapters/payments/legacy.adapter";
import { fungiesProvider } from "../../../../../payments/src/providers/fungies";
import { isEnabledPaymentProvider } from "../../../../../payments/src/settings_registry";

// Every provider with a reviewed verifier is built here. The launch switch (providers.json "enabled", or the
// inline defaults) decides which ones are offered a request. A switched-off provider's verifier is never offered
// a request, so its signature is not claimed and the request is refused as unverified, as an unknown provider is.
export function routableVerifiers() {
  return [new PolarAdapter(), new PaddleAdapter(), new LegacyPaymentAdapterWrapper(fungiesProvider)].filter((a) =>
    isEnabledPaymentProvider(a.providerName),
  );
}
