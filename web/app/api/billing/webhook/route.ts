import { PolarAdapter } from "../../../../../src/adapters/payments/polar.adapter";
import { PaddleAdapter } from "../../../../../src/adapters/payments/paddle.adapter";
import { LegacyPaymentAdapterWrapper } from "../../../../../src/adapters/payments/legacy.adapter";
import { fungiesProvider } from "../../../../../payments/src/providers/fungies";
import { isEnabledPaymentProvider } from "../../../../../payments/src/settings_registry";
import { createWebhookHandler } from "./handler";

export const runtime = "nodejs";

// Every provider with a reviewed verifier is built here, and the launch switch decides which ones take sales
// (providers.json "enabled"). A switched-off provider's verifier is never offered a request, so its
// signature is not claimed and the request is refused as unverified, exactly as an unknown provider would be.
export const POST = createWebhookHandler(() =>
  [new PolarAdapter(), new PaddleAdapter(), new LegacyPaymentAdapterWrapper(fungiesProvider)].filter((a) =>
    isEnabledPaymentProvider(a.providerName),
  ),
);
