// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BuyerEmailStep } from "../src/components/storefront/buyer-email-step";
import { buyerConsentText } from "../src/lib/buyer-email";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";

// The email controls on the buy form: typo suggestion, confirm mismatch, empty confirm, and the disabled-button reason.
// These run the real component, so a regression in the visible control fails here, not in front of a buyer.

const PRODUCT_ID = "57596c19-c550-4bde-b17a-e87b86d005c5";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount() {
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
        paddleClient: { token: "test_tok_client", environment: "sandbox" as const },
        railProvider: null,
      }),
    );
  });
  return container;
}

function typeInto(id: string, value: string) {
  const el = container!.querySelector<HTMLInputElement>(`#${id}`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function buyButton(): HTMLButtonElement {
  return container!.querySelector<HTMLButtonElement>("button[data-checkout-slot='primary']")!;
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

describe("buy form email controls", () => {
  it("suggests the correction for a typo domain (gmial.com)", () => {
    mount();
    typeInto("buyer-email", "kellybakri@gmial.com");
    expect(container!.textContent).toContain("Did you mean kellybakri@gmail.com?");
  });

  it("flags a confirm field that does not match, and keeps the button disabled", () => {
    mount();
    typeInto("buyer-email", "kellybakri@gmail.com");
    typeInto("buyer-email-confirm", "kellybakri@gmail.co");
    expect(container!.textContent).toContain("The two email addresses do not match yet.");
    expect(buyButton().disabled).toBe(true);
  });

  it("flags a confirm field that does not match when the typo is in the first field", () => {
    mount();
    typeInto("buyer-email", "kellybakri@gmial.com");
    typeInto("buyer-email-confirm", "kellybakri@gmail.com");
    expect(container!.textContent).toContain("The two email addresses do not match yet.");
    expect(buyButton().disabled).toBe(true);
  });

  it("says why the button is disabled while the confirm field is empty", () => {
    mount();
    typeInto("buyer-email", "kellybakri@gmail.com");
    expect(container!.textContent).toContain("Type the same address in Confirm email to continue.");
    expect(buyButton().disabled).toBe(true);
  });

  it("enables the button and shows no blocker when both fields match", () => {
    mount();
    typeInto("buyer-email", "kellybakri@gmail.com");
    typeInto("buyer-email-confirm", "kellybakri@gmail.com");
    expect(buyButton().disabled).toBe(false);
    expect(container!.textContent).not.toContain("to continue.");
    expect(container!.textContent).not.toContain("do not match");
  });
});
