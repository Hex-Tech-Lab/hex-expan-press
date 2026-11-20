import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL } from "../../../../payments/src/settings_registry";
import { ATTRIBUTION_KEYS } from "../attribution";
import {
  buyerCheckoutHref,
  buyerConsentText,
  buyerEmailState,
  buyerEmailsMatch,
  isValidBuyerEmail,
  storedAttributionParams,
  suggestBuyerEmail,
} from "../buyer-email";

const DOMAINS = DEFAULT_GLOBAL.email_address.typo_domains;
const MAX = DEFAULT_GLOBAL.email_address.max_length;

describe("suggestBuyerEmail", () => {
  it("suggests the registry domain for a probable domain typo", () => {
    expect(suggestBuyerEmail("ann@gmial.com", DOMAINS)).toBe("ann@gmail.com");
    expect(suggestBuyerEmail("ann@yaho.com", DOMAINS)).toBe("ann@yahoo.com");
  });

  it("suggests nothing for a domain already on the list", () => {
    expect(suggestBuyerEmail("ann@gmail.com", DOMAINS)).toBeUndefined();
  });

  it("suggests nothing for an unrelated domain", () => {
    expect(suggestBuyerEmail("ann@qwertyuiop-example.org", DOMAINS)).toBeUndefined();
  });

  it("suggests nothing for an empty or whitespace-only address", () => {
    expect(suggestBuyerEmail("", DOMAINS)).toBeUndefined();
    expect(suggestBuyerEmail("   ", DOMAINS)).toBeUndefined();
  });

  it("suggests nothing when the domain list is empty", () => {
    expect(suggestBuyerEmail("ann@gmial.com", [])).toBeUndefined();
  });
});

describe("isValidBuyerEmail", () => {
  it("accepts a well-formed address within the registry length", () => {
    expect(isValidBuyerEmail("ann@example.com", MAX)).toBe(true);
    expect(isValidBuyerEmail("  ann@example.com  ", MAX)).toBe(true);
  });

  it("rejects a malformed address", () => {
    expect(isValidBuyerEmail("ann@", MAX)).toBe(false);
    expect(isValidBuyerEmail("ann example@x.com", MAX)).toBe(false);
    expect(isValidBuyerEmail("", MAX)).toBe(false);
  });

  it("rejects an address over the length ceiling", () => {
    const long = `${"a".repeat(250)}@x.io`;
    expect(long.length).toBeGreaterThan(MAX);
    expect(isValidBuyerEmail(long, MAX)).toBe(false);
  });
});

describe("buyerEmailsMatch", () => {
  it("matches equal addresses after trimming surrounding spaces", () => {
    expect(buyerEmailsMatch("ann@example.com", "ann@example.com ")).toBe(true);
  });

  it("does not match a case-only difference", () => {
    expect(buyerEmailsMatch("ann@example.com", "Ann@example.com")).toBe(false);
  });

  it("never matches an empty pair", () => {
    expect(buyerEmailsMatch("", "")).toBe(false);
    expect(buyerEmailsMatch("   ", "   ")).toBe(false);
  });
});

describe("buyerEmailState", () => {
  const opts = { domains: DOMAINS, maxLength: MAX };

  it("enables the buy button only when the address is valid and the confirm field matches", () => {
    expect(buyerEmailState("ann@example.com", "ann@example.com", opts).canBuy).toBe(true);
  });

  it("keeps the buy button off on a mismatch", () => {
    expect(buyerEmailState("ann@example.com", "ann@example.co", opts).canBuy).toBe(false);
  });

  it("keeps the buy button off when both fields match but the address is invalid", () => {
    expect(buyerEmailState("not-an-email", "not-an-email", opts).canBuy).toBe(false);
  });

  it("shows a typo suggestion but leaves the typed address as typed and the button enabled", () => {
    const state = buyerEmailState("ann@gmial.com", "ann@gmial.com", opts);
    expect(state.suggestion).toBe("ann@gmail.com");
    expect(state.canBuy).toBe(true);
  });
});

describe("buyerConsentText", () => {
  it("renders the founder's consent line verbatim with the registry delivery promise and support address", () => {
    expect(buyerConsentText(2, 1, "support@expanpress.com")).toBe(
      "ExpanPress will email your e-book to this address, usually within 2 minutes. If it has not arrived within 1 hour, email support@expanpress.com and we will send it by hand. We may also email you about this purchase and related updates. You can unsubscribe at any time.",
    );
  });

  it("takes the timing and the support address from the arguments, not from fixed text", () => {
    const line = buyerConsentText(5, 12, "help@example.com");
    expect(line).toContain("usually within 5 minutes.");
    expect(line).toContain("If it has not arrived within 12 hours, email help@example.com and we will send it by hand.");
  });

  it("never states the retired six-hour promise", () => {
    expect(buyerConsentText(2, 1, "support@expanpress.com")).not.toMatch(/no later than|6 hours/);
  });
});

describe("storedAttributionParams", () => {
  it("reads each attribution parameter from its storage key and skips empty or missing values", () => {
    const store: Record<string, string> = { ep_src: "ig", ep_dub_id: "" };
    const params = storedAttributionParams((key) => store[key] ?? null, ATTRIBUTION_KEYS);
    expect(params).toEqual({ src: "ig" });
  });

  it("passes the parameter name to the reader for URL search fallback", () => {
    const qs = new URLSearchParams("?src=yt&dub_id=d1");
    const params = storedAttributionParams((_key, param) => qs.get(param), ATTRIBUTION_KEYS);
    expect(params).toEqual({ src: "yt", dub_id: "d1" });
  });
});

describe("buyerCheckoutHref", () => {
  it("carries the trimmed email, the consent choice and the attribution on the checkout URL", () => {
    const href = buyerCheckoutHref(
      "https://pay.expanpress.com/checkout/57596c19-c550-4bde-b17a-e87b86d005c5",
      { email: " ann@example.com ", consent: false },
      { src: "ig", dub_id: "abc" },
    );
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe("https://pay.expanpress.com/checkout/57596c19-c550-4bde-b17a-e87b86d005c5");
    expect(url.searchParams.get("buyer_email")).toBe("ann@example.com");
    expect(url.searchParams.get("buyer_consent")).toBe("false");
    expect(url.searchParams.get("src")).toBe("ig");
    expect(url.searchParams.get("dub_id")).toBe("abc");
  });

  it("sends consent true when the box is checked", () => {
    const url = new URL(buyerCheckoutHref("https://pay.expanpress.com/checkout/x", { email: "a@b.co", consent: true }, {}));
    expect(url.searchParams.get("buyer_consent")).toBe("true");
  });
});
