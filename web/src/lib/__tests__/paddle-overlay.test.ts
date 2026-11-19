import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL } from "../../../../payments/src/settings_registry";
import { buildPaddleOverlayPayload, paddleOverlayConfig, paddleOverlayUsable } from "../paddle-overlay-server";

const paddleJsMock = vi.hoisted(() => ({
  initializePaddle: vi.fn(),
  checkoutOpen: vi.fn(),
}));

vi.mock("@paddle/paddle-js", () => ({
  initializePaddle: (...args: unknown[]) => paddleJsMock.initializePaddle(...args),
}));

describe("paddleOverlayConfig (registry-named env vars, fail closed)", () => {
  const o = GLOBAL.payments.paddle.overlay;

  it("reads the client token and environment from the env vars named in the registry", () => {
    const cfg = paddleOverlayConfig({
      [o.client_token_env]: "  test_tok_abc  ",
      [o.environment_env]: "sandbox",
      VERCEL_ENV: "preview",
      NODE_ENV: "production",
    });
    expect(cfg).toEqual({ ok: true, client: { token: "test_tok_abc", environment: "sandbox" } });
  });

  it("refuses sandbox in production and missing/invalid tokens or environments", () => {
    expect(paddleOverlayConfig({ [o.client_token_env]: "", [o.environment_env]: "production" }).ok).toBe(false);
    expect(paddleOverlayConfig({ [o.client_token_env]: "tok", [o.environment_env]: "staging" }).ok).toBe(false);
    expect(
      paddleOverlayConfig({
        [o.client_token_env]: "test_tok",
        [o.environment_env]: "sandbox",
        VERCEL_ENV: "production",
        NODE_ENV: "production",
      }).ok,
    ).toBe(false);
  });
});

describe("paddleOverlayUsable and buildPaddleOverlayPayload", () => {
  it("matches client environment to product checkout_mode", () => {
    expect(paddleOverlayUsable({ token: "t", environment: "production" }, "live")).toBe(true);
    expect(paddleOverlayUsable({ token: "t", environment: "sandbox" }, "live")).toBe(false);
    expect(paddleOverlayUsable({ token: "t", environment: "sandbox" }, "sandbox")).toBe(true);
    expect(paddleOverlayUsable({ token: "t", environment: "production" }, "sandbox")).toBe(false);
  });

  it("builds Paddle.Checkout.open arguments from registry settings", () => {
    const payload = buildPaddleOverlayPayload({
      priceId: "pri_123",
      creatorHandle: "expanpress_house",
      orderRef: "ig:dub_9",
      buyerEmail: "buyer@example.com",
      buyerConsent: false,
    });
    expect(payload).toEqual({
      items: [{ priceId: "pri_123", quantity: 1 }],
      customer: { email: "buyer@example.com" },
      customData: {
        [GLOBAL.payments.paddle.overlay.order_ref_key]: "ig:dub_9",
        [GLOBAL.payments.paddle.overlay.buyer_consent_key]: "false",
      },
      settings: {
        displayMode: "overlay",
        theme: GLOBAL.payments.paddle.overlay.theme,
        locale: GLOBAL.payments.paddle.overlay.locale,
        successUrl: `${GLOBAL.delivery.download_origin}/books/expanpress_house/thanks`,
      },
    });
  });
});

describe("openPaddleOverlay (dynamic Paddle.js load + Paddle.Checkout.open)", () => {
  beforeEach(() => {
    vi.resetModules();
    paddleJsMock.initializePaddle.mockReset();
    paddleJsMock.checkoutOpen.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes Paddle with token and environment and opens Checkout with items, customer, customData, and settings", async () => {
    paddleJsMock.initializePaddle.mockResolvedValue({
      Checkout: { open: paddleJsMock.checkoutOpen },
    });
    const { openPaddleOverlay } = await import("../paddle-overlay");
    const payload = buildPaddleOverlayPayload({
      priceId: "pri_sandbox_1",
      creatorHandle: "ada",
      orderRef: "direct",
      buyerEmail: "ada.buyer@example.com",
      buyerConsent: true,
    });
    await openPaddleOverlay({ token: "test_tok_1", environment: "sandbox" }, payload);

    expect(paddleJsMock.initializePaddle).toHaveBeenCalledWith({ token: "test_tok_1", environment: "sandbox" });
    expect(paddleJsMock.checkoutOpen).toHaveBeenCalledWith({
      items: payload.items,
      customer: payload.customer,
      customData: payload.customData,
      settings: payload.settings,
    });
  });

  it("does not cache a failed Paddle.js load so the next submit retries", async () => {
    paddleJsMock.initializePaddle.mockRejectedValueOnce(new Error("CDN down"));
    paddleJsMock.initializePaddle.mockResolvedValueOnce({
      Checkout: { open: paddleJsMock.checkoutOpen },
    });
    const { openPaddleOverlay } = await import("../paddle-overlay");
    const payload = buildPaddleOverlayPayload({
      priceId: "pri_1",
      creatorHandle: "ada",
      orderRef: "direct",
      buyerEmail: "b@example.com",
      buyerConsent: true,
    });
    await expect(openPaddleOverlay({ token: "tok_retry", environment: "sandbox" }, payload)).rejects.toThrow("CDN down");
    await openPaddleOverlay({ token: "tok_retry", environment: "sandbox" }, payload);
    expect(paddleJsMock.initializePaddle).toHaveBeenCalledTimes(2);
    expect(paddleJsMock.checkoutOpen).toHaveBeenCalledTimes(1);
  });
});
