import { PolarAdapter } from "../../../../../src/adapters/payments/polar.adapter";
import { PaddleAdapter } from "../../../../../src/adapters/payments/paddle.adapter";
import { LegacyPaymentAdapterWrapper } from "../../../../../src/adapters/payments/legacy.adapter";
import { fungiesProvider } from "../../../../../payments/src/providers/fungies";
import { createWebhookHandler } from "./handler";

export const runtime = "nodejs";

// Only providers we sell through are routable (Polar, Paddle, Fungies);
// every other verifier is unreachable by design (sharp-edges audit
// 2026-10-01). Add a provider here only with a reviewed verifier.
export const POST = createWebhookHandler(() => [new PolarAdapter(), new PaddleAdapter(), new LegacyPaymentAdapterWrapper(fungiesProvider)]);
