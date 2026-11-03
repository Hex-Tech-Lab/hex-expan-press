import { describe, it, expect } from "vitest";
import { DEFAULT_PAYMENT_PROVIDERS, isEnabledPaymentProvider, isRegisteredPaymentProvider } from "../src/settings_registry";

// The launch switch: every configured provider stays defined (code, route and config are kept), and only an
// enabled one takes sales. These assertions read the exported inline defaults, which are the production fallback.
// They do not go through the loader, so a local data/settings/providers.json cannot change the result.

const EXPECTED_ENABLED: Record<string, boolean> = {
  paddle: true,
  fungies: true,
  polar: false,
  lemonsqueezy: false,
  payhip: false,
  fastspring: false,
};

describe("provider launch switch (inline defaults)", () => {
  it.each(Object.keys(EXPECTED_ENABLED))("%s is registered with the expected switch state", (name) => {
    expect(DEFAULT_PAYMENT_PROVIDERS[name]).toBeDefined();
    expect(DEFAULT_PAYMENT_PROVIDERS[name].enabled === true).toBe(EXPECTED_ENABLED[name]);
  });

  it("the switch reads the same flags as the defaults", () => {
    for (const [name, on] of Object.entries(EXPECTED_ENABLED)) {
      expect(isRegisteredPaymentProvider(name)).toBe(true);
      expect(DEFAULT_PAYMENT_PROVIDERS[name].enabled === true).toBe(on);
    }
  });

  it("an unknown provider is neither registered nor enabled", () => {
    expect(isRegisteredPaymentProvider("nosuchprovider")).toBe(false);
    expect(isEnabledPaymentProvider("nosuchprovider")).toBe(false);
  });
});
