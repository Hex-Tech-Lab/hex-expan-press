// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const overlayMock = vi.hoisted(() => ({
  openPaddleOverlay: vi.fn(),
}));

vi.mock("../src/lib/paddle-overlay", () => ({
  openPaddleOverlay: (...args: unknown[]) => overlayMock.openPaddleOverlay(...args),
}));

import { BuyerEmailStep } from "../src/components/storefront/buyer-email-step";
import { buyerConsentText } from "../src/lib/buyer-email";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";

const PRODUCT_ID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const PADDLE_CLIENT = { token: "test_tok_client", environment: "sandbox" as const };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(paddleClient: typeof PADDLE_CLIENT | null = PADDLE_CLIENT) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      React.createElement(BuyerEmailStep, {
        action: "/api/billing/checkout",
        productId: PRODUCT_ID,
        domains: [...DEFAULT_GLOBAL.email_address.typo_domains],
        maxEmailLength: DEFAULT_GLOBAL.email_address.max_length,
        consentText: buyerConsentText(
          DEFAULT_GLOBAL.delivery.buyer_typical_minutes,
          DEFAULT_GLOBAL.delivery.buyer_support_after_hours,
          DEFAULT_GLOBAL.email.reply_to,
        ),
        initialAttribution: { src: "ig" },
        paddleClient,
      }),
    );
  });
  return container;
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  overlayMock.openPaddleOverlay.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BuyerEmailStep client overlay & redirect flows", () => {
  it("submits confirmed email + consent as JSON and opens the Paddle overlay on paddle_overlay response", async () => {
    const payload = {
      items: [{ priceId: "pri_1", quantity: 1 }],
      customer: { email: "buyer@example.com" },
      customData: { order_ref: "ig", buyer_consent: "false" },
      settings: {
        displayMode: "overlay" as const,
        theme: "light" as const,
        locale: "en",
        successUrl: "https://expanpress.com/books/ada/thanks",
      },
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, kind: "paddle_overlay", payload }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    overlayMock.openPaddleOverlay.mockResolvedValue(undefined);

    const el = mount();
    setInput(el.querySelector("#buyer-email")!, "buyer@example.com");
    setInput(el.querySelector("#buyer-email-confirm")!, "buyer@example.com");
    const checkbox = el.querySelector('input[name="buyer_consent"]') as HTMLInputElement;
    act(() => {
      checkbox.click();
    });
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      product: PRODUCT_ID,
      buyer_email: "buyer@example.com",
      buyer_email_confirm: "buyer@example.com",
      buyer_consent: false,
      src: "ig",
    });
    expect(overlayMock.openPaddleOverlay).toHaveBeenCalledWith(PADDLE_CLIENT, payload);
  });

  it("follows redirectUrl without opening Paddle.js when the server routes another provider", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, kind: "redirect", redirectUrl: "https://creem.io/payment/prod_1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const el = mount();
    setInput(el.querySelector("#buyer-email")!, "buyer@example.com");
    setInput(el.querySelector("#buyer-email-confirm")!, "buyer@example.com");

    await act(async () => {
      el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(overlayMock.openPaddleOverlay).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("https://creem.io/payment/prod_1");
  });

  it("shows an accessible alert if Paddle.js fails to open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          kind: "paddle_overlay",
          payload: { items: [{ priceId: "pri_1", quantity: 1 }], customData: {}, settings: { displayMode: "overlay", theme: "light", locale: "en", successUrl: "https://expanpress.com/books/a/thanks" } },
        }),
      })),
    );
    overlayMock.openPaddleOverlay.mockRejectedValueOnce(new Error("blocked"));

    const el = mount();
    setInput(el.querySelector("#buyer-email")!, "buyer@example.com");
    setInput(el.querySelector("#buyer-email-confirm")!, "buyer@example.com");

    await act(async () => {
      el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Checkout could not be opened");
  });
});
