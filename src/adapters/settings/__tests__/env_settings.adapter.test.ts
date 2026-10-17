import { describe, it, expect } from "vitest";
import { EnvSettingsAdapter } from "../env_settings.adapter";

describe("EnvSettingsAdapter checkout strategy", () => {
  it("never includes polar in the checkout distribution", async () => {
    const settings = await new EnvSettingsAdapter().getPortalSettings();
    const providers = settings.payments.checkoutStrategy.distribution.map((d) => d.provider);
    expect(providers).not.toContain("polar");
  });

  it("sends all checkout weight to paddle", async () => {
    const settings = await new EnvSettingsAdapter().getPortalSettings();
    expect(settings.payments.checkoutStrategy.distribution).toEqual([{ provider: "paddle", weight: 100 }]);
  });
});
