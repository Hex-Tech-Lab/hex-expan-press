import { SettingsRegistryPort, PortalSettings } from "../../domain/settings/settings.port.ts";
import { GLOBAL } from "../../../payments/src/settings_registry.ts";

export class EnvSettingsAdapter implements SettingsRegistryPort {
  async getPortalSettings(): Promise<PortalSettings> {
    const routing = GLOBAL.payments.routing;
    return {
      esign: {
        strategy: {
          mode: '2d',
          distribution: [
            { provider: process.env.ESIGN_PRIMARY_PROVIDER || "firma", weight: 100 }
          ],
          fallbacks: process.env.ESIGN_FALLBACKS ? process.env.ESIGN_FALLBACKS.split(',') : []
        },
        revenueSplitDocumentPath: process.env.ESIGN_REVENUE_SPLIT_DOCUMENT_PATH || "legal-docs/revenue_split_agreement_v0.4.pdf"
      },
      payments: {
        checkoutStrategy: {
          mode: routing.mode,
          distribution: routing.distribution.map((route) => ({ ...route })),
          fallbacks: [...routing.fallbacks],
        }
      }
    };
  }
}
