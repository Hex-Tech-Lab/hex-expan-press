// Unit tests for the shared rail resolver (web/src/lib/checkout-rails.ts) and the purchasability rule.
import { describe, expect, it } from "vitest";
import { checkoutRailView, resolveCheckoutRails, usableRailsOf } from "../src/lib/checkout-rails";
import { isPurchasableProduct } from "../src/lib/product-purchasable";
import { checkoutUrlProblem } from "../app/api/billing/checkout/checkout-helpers";

const ALL_ON = {
  isEnabledProvider: () => true,
  verifiedProviders: new Set(["paddle", "creem"]),
  checkoutMode: "live",
  checkoutUrlProblem: () => null,
};
const rail = (provider: unknown, active: unknown = true, extra: Record<string, unknown> = {}) => ({
  provider,
  weight: 100,
  checkout_url: "https://buy.example/rail",
  active,
  ...extra,
});

describe("resolveCheckoutRails", () => {
  it("counts only active rails, and accepts the string 'true' as active", () => {
    const r = resolveCheckoutRails([rail("paddle", "true"), rail("creem", false)], ALL_ON);
    expect(r).toMatchObject({ kind: "ok", configuredCount: 2 });
    expect(usableRailsOf(r).map((u) => u.provider)).toEqual(["paddle"]);
  });

  it("drops a rail whose provider is switched off in the registry", () => {
    const r = resolveCheckoutRails([rail("paddle"), rail("creem")], { ...ALL_ON, isEnabledProvider: (p) => p !== "creem" });
    expect(usableRailsOf(r).map((u) => u.provider)).toEqual(["paddle"]);
  });

  it("drops a rail whose provider has no webhook verifier, so an unverifiable rail cannot take a buyer", () => {
    const r = resolveCheckoutRails([rail("paddle"), rail("creem")], { ...ALL_ON, verifiedProviders: new Set(["paddle"]) });
    expect(usableRailsOf(r).map((u) => u.provider)).toEqual(["paddle"]);
  });

  it("answers no usable rails when every configured rail is inactive, which the route turns into 503", () => {
    const r = resolveCheckoutRails([rail("paddle", false)], ALL_ON);
    expect(r).toMatchObject({ kind: "ok", configuredCount: 1 });
    expect(usableRailsOf(r)).toEqual([]);
  });

  it("is malformed for a non-object row", () => {
    expect(resolveCheckoutRails([null], ALL_ON)).toEqual({ kind: "malformed", reason: "non_object_row" });
  });

  it("is malformed for an active row with a missing provider, a non-string checkout_url, or a bad weight", () => {
    expect(resolveCheckoutRails([rail("")], ALL_ON)).toEqual({ kind: "malformed", reason: "invalid_active_row" });
    expect(resolveCheckoutRails([rail("paddle", true, { checkout_url: 7 })], ALL_ON)).toEqual({ kind: "malformed", reason: "invalid_active_row" });
    expect(resolveCheckoutRails([rail("paddle", true, { weight: -1 })], ALL_ON)).toEqual({ kind: "malformed", reason: "invalid_weight" });
    // Number(null) is 0: a null weight must not pass as a valid rail.
    expect(resolveCheckoutRails([rail("paddle", true, { weight: null })], ALL_ON)).toEqual({ kind: "malformed", reason: "invalid_active_row" });
  });

  it("ignores the fields of an inactive row, as the route always did", () => {
    const r = resolveCheckoutRails([rail("", false), rail("paddle")], ALL_ON);
    expect(usableRailsOf(r).map((u) => u.provider)).toEqual(["paddle"]);
  });

  it("is malformed for a zero weight: the routing contract is weight > 0, so a zero-weight rail is never usable", () => {
    // Named invalid_weight, not invalid_active_row: the operator log must point at the weight, not the provider or URL.
    expect(resolveCheckoutRails([rail("paddle", true, { weight: 0 })], ALL_ON)).toEqual({ kind: "malformed", reason: "invalid_weight" });
    expect(resolveCheckoutRails([rail("paddle", true, { weight: "0" })], ALL_ON)).toEqual({ kind: "malformed", reason: "invalid_weight" });
  });

  it("a zero-weight row next to a healthy rail fails the whole set closed (the documented contract, not a skip)", () => {
    expect(resolveCheckoutRails([rail("paddle", true, { weight: 100 }), rail("creem", true, { weight: 0 })], ALL_ON)).toEqual({
      kind: "malformed",
      reason: "invalid_weight",
    });
  });

  it("is malformed for a blank weight string, which Number('') would read as 0", () => {
    expect(resolveCheckoutRails([rail("paddle", true, { weight: "  " })], ALL_ON)).toEqual({ kind: "malformed", reason: "invalid_active_row" });
  });

  it("is malformed when a usable rail's checkout_url fails the route's check (route answers 500, so the page must not sell)", () => {
    const withRealCheck = { ...ALL_ON, checkoutUrlProblem: checkoutUrlProblem };
    const r = resolveCheckoutRails([rail("paddle", true, { checkout_url: "http://buy.paddle.com/x" })], withRealCheck);
    expect(r).toEqual({ kind: "malformed", reason: "invalid_checkout_url" });
  });

  it("is malformed for a live product whose usable rail points at a sandbox host (the route answers 500)", () => {
    const withRealCheck = { ...ALL_ON, checkoutUrlProblem: checkoutUrlProblem };
    const r = resolveCheckoutRails([rail("paddle", true, { checkout_url: "https://sandbox-buy.paddle.com/x" })], withRealCheck);
    expect(r).toEqual({ kind: "malformed", reason: "invalid_checkout_url" });
  });

  it("does not URL-check an inactive or unverified rail, as the route only checks the rails it selects", () => {
    const withRealCheck = { ...ALL_ON, checkoutUrlProblem: checkoutUrlProblem, verifiedProviders: new Set(["paddle"]) };
    const r = resolveCheckoutRails(
      [rail("paddle", true), rail("creem", true, { checkout_url: "http://bad.example" }), rail("paddle", false, { checkout_url: "http://bad" })],
      withRealCheck,
    );
    expect(r.kind).toBe("ok");
    expect(usableRailsOf(r).map((u) => u.provider)).toEqual(["paddle"]);
  });

  it("treats a missing row list as zero configured rails", () => {
    expect(resolveCheckoutRails(null, ALL_ON)).toEqual({ kind: "ok", configuredCount: 0, usable: [] });
  });

  it("counts a malformed result as zero usable rails for buyer surfaces", () => {
    expect(usableRailsOf({ kind: "malformed", reason: "invalid_active_row" })).toEqual([]);
  });
});

describe("checkoutRailView", () => {
  const live = { checkout_mode: "live", price_usd: "9" };

  it("names the merchant of record only for exactly one usable rail", () => {
    const one = usableRailsOf(resolveCheckoutRails([rail("creem")], ALL_ON));
    expect(checkoutRailView(live, one)).toEqual({ purchasable: true, merchantOfRecordProvider: "creem" });
  });

  it("keeps the POST fallback and no merchant of record with two or more rails", () => {
    const two = usableRailsOf(resolveCheckoutRails([rail("paddle"), rail("creem")], ALL_ON));
    expect(checkoutRailView(live, two)).toEqual({ purchasable: true, merchantOfRecordProvider: null });
  });

  it("is not purchasable with zero rails", () => {
    expect(checkoutRailView(live, [])).toEqual({ purchasable: false, merchantOfRecordProvider: null });
  });
});

describe("isPurchasableProduct", () => {
  it("needs live, a usable price, and at least one usable rail", () => {
    expect(isPurchasableProduct({ checkout_mode: "live", price_usd: "9" }, 1)).toBe(true);
    expect(isPurchasableProduct({ checkout_mode: "live", price_usd: "9" }, 0)).toBe(false);
    expect(isPurchasableProduct({ checkout_mode: "live", price_usd: null }, 2)).toBe(false);
    expect(isPurchasableProduct({ checkout_mode: "gated", price_usd: "9" }, 1)).toBe(false);
  });
});
