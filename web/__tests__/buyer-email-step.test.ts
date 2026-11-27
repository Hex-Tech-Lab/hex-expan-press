import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuyerEmailStep } from "../src/components/storefront/buyer-email-step";
import { buyerConsentText } from "../src/lib/buyer-email";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";

const ACTION = "/api/billing/checkout";
const PRODUCT_ID = "57596c19-c550-4bde-b17a-e87b86d005c5";

function render(initialAttribution?: Record<string, string>): string {
  return renderToStaticMarkup(
    createElement(BuyerEmailStep, {
      action: ACTION,
      productId: PRODUCT_ID,
      domains: [...DEFAULT_GLOBAL.email_address.typo_domains],
      maxEmailLength: DEFAULT_GLOBAL.email_address.max_length,
      consentText: buyerConsentText(DEFAULT_GLOBAL.delivery.buyer_typical_minutes, DEFAULT_GLOBAL.delivery.buyer_support_after_hours, DEFAULT_GLOBAL.email.reply_to),
      initialAttribution,
    }),
  );
}

describe("BuyerEmailStep initial render (Option A single-hop POST)", () => {
  it("submits as a POST form to /api/billing/checkout with product, email, confirm, and consent without JavaScript", () => {
    const html = render();
    expect(html).toContain(`action="${ACTION}"`);
    expect(html).toContain('method="post"');
    expect(html).toContain(`<input type="hidden" name="product" value="${PRODUCT_ID}"/>`);
    expect(html).toContain('name="buyer_email"');
    expect(html).toContain('name="buyer_email_confirm"');
    expect(html).toContain('required=""');
    expect(html).not.toContain('novalidate=""');
  });

  it("renders the consent checkbox checked by default with name=buyer_consent and value=true", () => {
    const html = render();
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "";
    expect(checkbox).toContain('name="buyer_consent"');
    expect(checkbox).toContain('value="true"');
    expect(checkbox).toContain('checked=""');
  });

  it("shows the consent line verbatim, with the registry delivery promise", () => {
    expect(render()).toContain(
      "ExpanPress emails a secure download link for your e-book to this address, usually within 2 minutes. If the link has not arrived within 1 hour, email support@expanpress.com, and a support agent will send it to you manually. Support messages are answered in the order they are received. We may also email you about this purchase and related updates. You can unsubscribe at any time.",
    );
  });

  it("keeps the SSR submit button enabled for no-JS progressive enhancement (hydration disables until valid & matching)", () => {
    const html = render();
    const button = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? "";
    expect(button).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).toContain('data-checkout-slot="primary"');
    expect(html).toContain('data-checkout-mode="live"');
  });

  it("renders server-read initialAttribution as hidden inputs for no-JS POST submissions", () => {
    const html = render({ src: "ig", dub_id: "dub_123" });
    expect(html).toContain('<input type="hidden" name="src" value="ig"/>');
    expect(html).toContain('<input type="hidden" name="dub_id" value="dub_123"/>');
  });

  it("renders BrandField and BrandButton shared primitives (focus ring, disabled, hover from brand.tsx)", () => {
    const html = render();
    const emailInput = html.match(/<input[^>]*id="buyer-email"[^>]*>/)?.[0] ?? "";
    const confirmInput = html.match(/<input[^>]*id="buyer-email-confirm"[^>]*>/)?.[0] ?? "";
    const submitBtn = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? "";
    expect(emailInput).toContain("focus-visible:outline-[#E8622C]");
    expect(confirmInput).toContain("focus-visible:outline-[#E8622C]");
    expect(submitBtn).toContain("focus-visible:outline-[#E8622C]");
    expect(submitBtn).toContain("disabled:bg-[#9a9a9a]");
    expect(submitBtn).toContain("hover:bg-[#383838]");
  });
});
