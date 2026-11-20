import { describe, it, expect, afterEach } from "vitest";
import { EnvSettingsAdapter } from "../env_settings.adapter";
import { GLOBAL } from "../../../../payments/src/settings_registry";

describe("EnvSettingsAdapter checkout strategy", () => {
  const originalRouting = {
    mode: GLOBAL.payments.routing.mode,
    distribution: GLOBAL.payments.routing.distribution.map((r) => ({ ...r })),
    fallbacks: [...GLOBAL.payments.routing.fallbacks],
  };

  afterEach(() => {
    GLOBAL.payments.routing = {
      mode: originalRouting.mode,
      distribution: originalRouting.distribution.map((r) => ({ ...r })),
      fallbacks: [...originalRouting.fallbacks],
    };
  });

  it("never includes polar in the checkout distribution", async () => {
    const settings = await new EnvSettingsAdapter().getPortalSettings();
    const providers = settings.payments.checkoutStrategy.distribution.map((d) => d.provider);
    expect(providers).not.toContain("polar");
  });

  it("sends all checkout weight to paddle", async () => {
    const settings = await new EnvSettingsAdapter().getPortalSettings();
    expect(settings.payments.checkoutStrategy.distribution).toEqual([{ provider: "paddle", weight: 100 }]);
  });

  it("reads checkout routing weights and fallbacks from GLOBAL.payments.routing (B-04)", async () => {
    GLOBAL.payments.routing = {
      mode: "cascade",
      distribution: [{ provider: "creem", weight: 70 }, { provider: "paddle", weight: 30 }],
      fallbacks: ["fungies"],
    };
    const settings = await new EnvSettingsAdapter().getPortalSettings();
    expect(settings.payments.checkoutStrategy).toEqual({
      mode: "cascade",
      distribution: [{ provider: "creem", weight: 70 }, { provider: "paddle", weight: 30 }],
      fallbacks: ["fungies"],
    });
  });
});
