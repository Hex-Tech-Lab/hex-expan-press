import { describe, expect, it, vi } from "vitest";
import { GLOBAL } from "../../payments/src/settings_registry";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => null) }));

import { allowedStorefrontCheckoutModes, isVisibleStorefrontProduct } from "../src/components/storefront/storefront";

describe("storefront sandbox gate", () => {
  it("allowedStorefrontCheckoutModes includes 'sandbox' only when sandboxOpen is true", () => {
    expect(allowedStorefrontCheckoutModes(GLOBAL.storefront, true)).toContain("sandbox");
    expect(allowedStorefrontCheckoutModes(GLOBAL.storefront, true)).toContain("live");

    // Negative control: with sandboxOpen false (or omitted), "sandbox" must not be included.
    expect(allowedStorefrontCheckoutModes(GLOBAL.storefront, false)).not.toContain("sandbox");
    expect(allowedStorefrontCheckoutModes(GLOBAL.storefront)).not.toContain("sandbox");
  });

  it("isVisibleStorefrontProduct shows a non-sample sandbox product only when sandboxOpen is true", () => {
    const sandboxNonSample = { checkout_mode: "sandbox", is_sample: false };
    expect(isVisibleStorefrontProduct(sandboxNonSample, GLOBAL.storefront, true)).toBe(true);

    // Negative control: with sandboxOpen false (or omitted), a non-sample sandbox product stays hidden.
    expect(isVisibleStorefrontProduct(sandboxNonSample, GLOBAL.storefront, false)).toBe(false);
    expect(isVisibleStorefrontProduct(sandboxNonSample, GLOBAL.storefront)).toBe(false);

    // Negative control: sandboxOpen true never exposes a non-sample gated product.
    expect(isVisibleStorefrontProduct({ checkout_mode: "gated", is_sample: false }, GLOBAL.storefront, true)).toBe(false);
  });
});
