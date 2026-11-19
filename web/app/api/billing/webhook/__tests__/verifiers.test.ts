import { describe, it, expect, vi } from "vitest";

// Use the inline defaults, not a local data/settings/providers.json, so the expected set is fixed on every machine.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => false };
});

import { buildWebhookVerifiers, routableVerifiers, verifiedProviderNames } from "../verifiers";
import { DEFAULT_PAYMENT_PROVIDERS } from "../../../../../../payments/src/settings_registry";

// Pins the real switch through the route's verifier list (not a mocked switch): with the inline defaults,
// only Paddle is offered requests. Registered switched-off providers are still built from PAYMENT_PROVIDERS
// so config-only activation works and switched-off deliveries can be audited for manual review.
describe("webhook verifier list follows the launch switch and registry (B-03)", () => {
  it("offers only Paddle, and not the switched-off providers", () => {
    expect(routableVerifiers().map((a) => a.providerName)).toEqual(["paddle"]);
  });

  // Invariant: a provider switched on in the defaults must have a verifier here, or buyers would be sent to a
  // rail whose webhooks are refused.
  it("every provider switched on in the defaults has a verifier", () => {
    const enabled = Object.entries(DEFAULT_PAYMENT_PROVIDERS).filter(([, p]) => p.enabled === true).map(([n]) => n);
    const routable = routableVerifiers().map((a) => a.providerName);
    for (const name of enabled) expect(routable).toContain(name);
  });

  it("instantiates verifiers for every registered provider in DEFAULT_PAYMENT_PROVIDERS including lemonsqueezy, payhip, fastspring", () => {
    const names = verifiedProviderNames();
    for (const registered of Object.keys(DEFAULT_PAYMENT_PROVIDERS)) {
      expect(names.has(registered), registered).toBe(true);
    }
    const subset = buildWebhookVerifiers({ paddle: DEFAULT_PAYMENT_PROVIDERS.paddle });
    expect(subset.map((a) => a.providerName)).toEqual(["paddle"]);
  });
});
