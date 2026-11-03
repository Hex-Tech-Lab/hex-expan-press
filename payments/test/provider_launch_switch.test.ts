import { describe, it, expect } from "vitest";
import { isEnabledPaymentProvider, isRegisteredPaymentProvider } from "../src/settings_registry";

// The launch switch: every configured provider stays defined (code, route and config are kept), and only an
// enabled one takes sales. Runs against the inline defaults (the production fallback), not a local file.

describe("provider launch switch (settings registry)", () => {
  it("Paddle is the launch rail and is enabled", () => {
    expect(isRegisteredPaymentProvider("paddle")).toBe(true);
    expect(isEnabledPaymentProvider("paddle")).toBe(true);
  });

  it("Polar stays defined but is switched off, so it takes no sales", () => {
    expect(isRegisteredPaymentProvider("polar")).toBe(true);
    expect(isEnabledPaymentProvider("polar")).toBe(false);
  });

  it("Fungies stays enabled, as master routed it before the switch existed", () => {
    expect(isRegisteredPaymentProvider("fungies")).toBe(true);
    expect(isEnabledPaymentProvider("fungies")).toBe(true);
  });

  it.each(["lemonsqueezy", "payhip", "fastspring"])("%s is defined and switched off", (name) => {
    expect(isRegisteredPaymentProvider(name)).toBe(true);
    expect(isEnabledPaymentProvider(name)).toBe(false);
  });

  it("an unknown provider is neither registered nor enabled", () => {
    expect(isRegisteredPaymentProvider("nosuchprovider")).toBe(false);
    expect(isEnabledPaymentProvider("nosuchprovider")).toBe(false);
  });
});
