import { describe, it, expect, vi } from "vitest";

// Use the inline defaults, not a local data/settings/providers.json, so the expected set is fixed on every machine.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => false };
});

import { routableVerifiers, verifiedProviderNames } from "../verifiers";
import { DEFAULT_PAYMENT_PROVIDERS } from "../../../../../../payments/src/settings_registry";

// Pins the real switch through the route's verifier list (not a mocked switch): with the inline defaults,
// only Paddle is offered requests. Fungies and Polar are switched off, so their verifiers are not offered.
describe("webhook verifier list follows the launch switch", () => {
  it("offers only Paddle, and not the switched-off Fungies or Polar", () => {
    expect(routableVerifiers().map((a) => a.providerName)).toEqual(["paddle"]);
  });

  // Invariant: a provider switched on in the defaults must have a verifier here, or buyers would be sent to a
  // rail whose webhooks are refused.
  it("every provider switched on in the defaults has a verifier", () => {
    const enabled = Object.entries(DEFAULT_PAYMENT_PROVIDERS).filter(([, p]) => p.enabled === true).map(([n]) => n);
    const routable = routableVerifiers().map((a) => a.providerName);
    for (const name of enabled) expect(routable).toContain(name);
  });

  it("only providers with a verifier can be offered a buyer", () => {
    const names = verifiedProviderNames();
    expect(names.has("paddle")).toBe(true);
    expect(names.has("fungies")).toBe(true);
    expect(names.has("polar")).toBe(true);
    expect(names.has("lemonsqueezy")).toBe(false);
  });
});
