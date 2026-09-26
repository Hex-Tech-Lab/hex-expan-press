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
        revenueSplitDocumentPath: process.env.ESIGN_REVENUE_SPLIT_DOCUMENT_PATH || "legal-docs/revenue_split_agreement_v0.1.pdf"
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
