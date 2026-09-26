import { SettingsRegistryPort, PortalSettings } from "../../domain/settings/settings.port.ts";

export class EnvSettingsAdapter implements SettingsRegistryPort {
  async getPortalSettings(): Promise<PortalSettings> {
    return {
      esign: {
        strategy: {
          mode: '2d',
          distribution: [
            { provider: process.env.ESIGN_PRIMARY_PROVIDER || "firma", weight: 100 }
          ],
          fallbacks: process.env.ESIGN_FALLBACKS ? process.env.ESIGN_FALLBACKS.split(',') : []
        },
        revenueSplitTemplateId: process.env.ESIGN_REVENUE_SPLIT_TEMPLATE_ID || "revenue-split-template"
      },
      payments: {
        checkoutStrategy: {
          mode: '2d',
          distribution: [
            { provider: "polar", weight: 50 },
            { provider: "paddle", weight: 50 }
          ],
          fallbacks: ["lemonsqueezy", "fastspring"]
        }
      }
    };
  }
}
