// Launch gate matrix for isLaunchOpen, isPurchasableProduct, and checkoutRailView.
import { describe, expect, it } from "vitest";
import { checkoutRailView, type UsableRail } from "../src/lib/checkout-rails";
import { isLaunchOpen, isPurchasableProduct } from "../src/lib/product-purchasable";

const MODES = ["live", "sandbox", "gated", null] as const;
const SANDBOX_FLAGS = [true, false] as const;
const PRICES = ["39", "0", null] as const;
const RAIL_COUNTS = [0, 1, 2] as const;

const SAMPLE_RAILS: UsableRail[] = [
  { provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/launch-gate-1" },
  { provider: "creem", weight: 50, checkout_url: "https://creem.io/launch-gate-2" },
];

type MatrixCase = {
  checkout_mode: (typeof MODES)[number];
  sandboxAllowed: boolean;
  price_usd: (typeof PRICES)[number];
  railCount: (typeof RAIL_COUNTS)[number];
};

const MATRIX: MatrixCase[] = [];
for (const checkout_mode of MODES) {
  for (const sandboxAllowed of SANDBOX_FLAGS) {
    for (const price_usd of PRICES) {
      for (const railCount of RAIL_COUNTS) {
        MATRIX.push({ checkout_mode, sandboxAllowed, price_usd, railCount });
      }
    }
  }
}

describe("launch gate matrix (isLaunchOpen, isPurchasableProduct, checkoutRailView)", () => {
  it.each(MATRIX)(
    "mode=$checkout_mode sandboxAllowed=$sandboxAllowed price=$price_usd rails=$railCount",
    ({ checkout_mode, sandboxAllowed, price_usd, railCount }) => {
      const product = { checkout_mode, price_usd };
      const usable = SAMPLE_RAILS.slice(0, railCount);

      const expectedOpen = checkout_mode === "live" || (checkout_mode === "sandbox" && sandboxAllowed);
      const expectedPriced = price_usd === "39";
      const expectedPurchasable = expectedOpen && expectedPriced && railCount >= 1;
      const expectedMor = expectedPurchasable && railCount === 1 ? "paddle" : null;

      expect(isLaunchOpen(product, sandboxAllowed)).toBe(expectedOpen);
      expect(isPurchasableProduct(product, railCount, sandboxAllowed)).toBe(expectedPurchasable);
      expect(checkoutRailView(product, usable, sandboxAllowed)).toEqual({
        purchasable: expectedPurchasable,
        merchantOfRecordProvider: expectedMor,
      });
    },
  );

  // Negative control: sandbox with sandboxAllowed false is never purchasable (even when priced "39" and rails >= 1).
  it("negative control: sandbox with sandboxAllowed false is never purchasable", () => {
    const sandboxProduct = { checkout_mode: "sandbox", price_usd: "39" };
    expect(isLaunchOpen(sandboxProduct, false)).toBe(false);
    expect(isPurchasableProduct(sandboxProduct, 1, false)).toBe(false);
    expect(isPurchasableProduct(sandboxProduct, 2, false)).toBe(false);
    expect(checkoutRailView(sandboxProduct, SAMPLE_RAILS.slice(0, 1), false)).toEqual({
      purchasable: false,
      merchantOfRecordProvider: null,
    });
    expect(checkoutRailView(sandboxProduct, SAMPLE_RAILS, false)).toEqual({
      purchasable: false,
      merchantOfRecordProvider: null,
    });
  });
});
