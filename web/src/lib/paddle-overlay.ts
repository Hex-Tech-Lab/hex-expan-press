/**
 * Paddle.js overlay checkout, opened on pay.expanpress.com after the buyer email step (option A).
 *
 * Client-safe: this module imports no settings registry (it reads node:fs). The server builds the payload and passes the
 * client token and environment to the page as props. Paddle.js itself is loaded only when a buyer submits the email step,
 * through a dynamic import, so the provider SDK is never fetched on a page where no checkout starts (ADR 0061: provider SDKs
 * load only on the pay host).
 *
 * Paddle.js pattern (developer.paddle.com, paddle-js methods): initializePaddle({ token, environment }) resolves the
 * Paddle instance; Paddle.Checkout.open({ items, customer, customData, settings }) opens the overlay.
 */

export type PaddleEnvironmentName = "sandbox" | "production";

/** What the page needs to open the overlay: a client-side token and the environment it belongs to. */
export interface PaddleOverlayClient {
  token: string;
  environment: PaddleEnvironmentName;
}

/** The checkout the server returns for a Paddle rail: the Paddle.Checkout.open() arguments, with no secret in them. */
export interface PaddleOverlayPayload {
  items: Array<{ priceId: string; quantity: number }>;
  customer?: { email: string };
  customData: Record<string, string>;
  settings: {
    displayMode: "overlay";
    theme: "light" | "dark";
    locale: string;
    successUrl: string;
  };
}

type PaddleInstance = {
  Checkout: {
    open: (options: {
      items: Array<{ priceId: string; quantity: number }>;
      customer?: { email: string };
      customData?: Record<string, unknown>;
      settings?: PaddleOverlayPayload["settings"];
    }) => void;
  };
};

/** One Paddle instance per token, environment, and checkout theme/locale. A failed load is not cached, so the next submit can try again. */
let cached: { key: string; instance: Promise<PaddleInstance | undefined> } | null = null;

async function paddleInstance(
  client: PaddleOverlayClient,
  checkoutSettings: Pick<PaddleOverlayPayload["settings"], "displayMode" | "theme" | "locale">,
): Promise<PaddleInstance> {
  const key = `${client.environment}:${client.token}:${checkoutSettings.displayMode}:${checkoutSettings.theme}:${checkoutSettings.locale}`;
  if (cached === null || cached.key !== key) {
    const instance = import("@paddle/paddle-js").then(({ initializePaddle }) =>
      initializePaddle({
        token: client.token,
        environment: client.environment,
        checkout: {
          settings: {
            displayMode: checkoutSettings.displayMode,
            theme: checkoutSettings.theme,
            locale: checkoutSettings.locale,
          },
        },
      }) as Promise<PaddleInstance | undefined>,
    );
    cached = { key, instance };
  }
  const entry = cached;
  let paddle: PaddleInstance | undefined;
  try {
    paddle = await entry.instance;
  } catch (err) {
    if (cached === entry) cached = null;
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (!paddle) {
    if (cached === entry) cached = null;
    throw new Error("Paddle checkout failed to load");
  }
  return paddle;
}

/** Opens the Paddle overlay with the server's payload. Rejects if Paddle.js cannot load; the caller shows the buyer a message. */
export async function openPaddleOverlay(client: PaddleOverlayClient, payload: PaddleOverlayPayload): Promise<void> {
  const paddle = await paddleInstance(client, {
    displayMode: payload.settings.displayMode,
    theme: payload.settings.theme,
    locale: payload.settings.locale,
  });
  paddle.Checkout.open({
    items: payload.items,
    ...(payload.customer ? { customer: payload.customer } : {}),
    customData: payload.customData,
    settings: payload.settings,
  });
}
