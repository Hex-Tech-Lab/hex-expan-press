import { describe, it, expect, vi } from "vitest";

// Force the loader to ignore any local data/settings/*.json, so the switch is read from the inline defaults
// (the production fallback) on every machine. Without this, a local providers.json could change the result.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => false };
});

import { DEFAULT_PAYMENT_PROVIDERS, isEnabledPaymentProvider, isRegisteredPaymentProvider } from "../src/settings_registry";
import type { ProviderName } from "../src/provider";

// Every configured provider stays defined (code, route and config are kept). Only an enabled one takes sales.
const EXPECTED_ENABLED: Record<ProviderName, boolean> = {
  paddle: true,
  creem: false,
  fungies: false,
  polar: false,
  lemonsqueezy: false,
  payhip: false,
  fastspring: false,
};

describe("provider launch switch (inline defaults, local file ignored)", () => {
  it("ProviderName and EXPECTED_ENABLED cover the exact keys of DEFAULT_PAYMENT_PROVIDERS", () => {
    expect(Object.keys(EXPECTED_ENABLED).sort()).toEqual(Object.keys(DEFAULT_PAYMENT_PROVIDERS).sort());
  });

  it.each(Object.keys(EXPECTED_ENABLED) as ProviderName[])("%s is registered and the real switch matches its expected state", (name) => {
    expect(isRegisteredPaymentProvider(name)).toBe(true);
    expect(isEnabledPaymentProvider(name)).toBe(EXPECTED_ENABLED[name]);
  });

  it.each(Object.keys(EXPECTED_ENABLED) as ProviderName[])("%s defaults agree with the switch", (name) => {
    expect(DEFAULT_PAYMENT_PROVIDERS[name].enabled === true).toBe(EXPECTED_ENABLED[name]);
  });

  it("an unknown provider is neither registered nor enabled", () => {
    expect(isRegisteredPaymentProvider("nosuchprovider")).toBe(false);
    expect(isEnabledPaymentProvider("nosuchprovider")).toBe(false);
  });
});
