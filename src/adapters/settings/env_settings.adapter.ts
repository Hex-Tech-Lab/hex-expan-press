import { SettingsRegistryPort, PortalSettings } from "../../domain/settings/settings.port.ts";

export class EnvSettingsAdapter implements SettingsRegistryPort {
  async getPortalSettings(): Promise<PortalSettings> {
    // In the future, this might read from a Postgres table or JSON file.
    // For now, it respects the environment/JSON registry pattern.
    return {
      esign: {
        activeProvider: process.env.ESIGN_PROVIDER || "firma",
        revenueSplitTemplateId: process.env.ESIGN_REVENUE_SPLIT_TEMPLATE_ID || "revenue-split-template"
      }
    };
  }
}
