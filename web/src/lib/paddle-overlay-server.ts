/**
 * Server side of the Paddle.js overlay (option A). Reads the token and environment through the NAMES the settings registry
 * holds (payments.paddle.overlay), fails closed when either is missing or not allowed, and builds the Paddle.Checkout.open()
 * payload the checkout route returns. Nothing here is imported by client code.
 */
import { GLOBAL } from "../../../payments/src/settings_registry";
import { paddleInitializeCheckoutSettings } from "../../../payments/src/checkout_branding";
import { resolvePaddleEnvironment } from "./paddle-env";
import type { PaddleEnvironmentName, PaddleOverlayClient, PaddleOverlayPayload } from "./paddle-overlay";

export type PaddleOverlayConfig = { ok: true; client: PaddleOverlayClient } | { ok: false; reason: string };

/** The overlay's client token and environment, from the environment variables the registry names. `env` is injectable for tests. */
export function paddleOverlayConfig(env: Record<string, string | undefined> = process.env): PaddleOverlayConfig {
  const o = GLOBAL.payments.paddle.overlay;
  const token = (env[o.client_token_env] ?? "").trim();
  if (token === "") return { ok: false, reason: `${o.client_token_env} is not configured` };
  const raw = env[o.environment_env];
  if (raw !== "sandbox" && raw !== "production") {
    return { ok: false, reason: `${o.environment_env} must be sandbox or production` };
  }
  // An empty VERCEL_ENV and NODE_ENV are passed as "" (not undefined): resolvePaddleEnvironment would otherwise read its own
  // process.env defaults. An empty value takes the fail-closed branch: sandbox needs a positive non-production signal.
  const resolved = resolvePaddleEnvironment(raw, env.VERCEL_ENV ?? "", env.NODE_ENV ?? "");
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return { ok: true, client: { token, environment: resolved.env } };
}

/** The overlay opens only when its environment is the one the product's checkout_mode belongs to: a live product never opens
 *  the sandbox overlay, and a sandbox product never opens the production one. */
export function paddleOverlayUsable(client: PaddleOverlayClient, checkoutMode: string | null | undefined): boolean {
  const expected: PaddleEnvironmentName = checkoutMode === "sandbox" ? "sandbox" : "production";
  return client.environment === expected;
}

/** The Paddle.Checkout.open() arguments for one buyer. No secret; the buyer's email is a prefill, not an identity. */
export function buildPaddleOverlayPayload(input: {
  priceId: string;
  creatorHandle: string;
  orderRef: string;
  buyerEmail?: string;
  buyerConsent: boolean;
}): PaddleOverlayPayload {
  const o = GLOBAL.payments.paddle.overlay;
  const brandingSettings = paddleInitializeCheckoutSettings(GLOBAL.branding, o);
  const origin = GLOBAL.delivery.download_origin.replace(/\/$/, "");
  const thanks = GLOBAL.storefront.thanks_path_template.replace("{handle}", encodeURIComponent(input.creatorHandle));
  const customData: Record<string, string> = { [o.buyer_consent_key]: input.buyerConsent ? "true" : "false" };
  if (input.orderRef !== "") customData[o.order_ref_key] = input.orderRef;
  return {
    items: [{ priceId: input.priceId, quantity: 1 }],
    ...(input.buyerEmail ? { customer: { email: input.buyerEmail } } : {}),
    customData,
    settings: {
      ...brandingSettings,
      successUrl: `${origin}${thanks}`,
    },
  };
}
