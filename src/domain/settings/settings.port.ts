export interface EsignSettings {
  activeProvider: string; // e.g., 'firma', 'docusign'
  revenueSplitTemplateId: string;
}

export interface PortalSettings {
  esign: EsignSettings;
  // future domain settings go here
}

export interface SettingsRegistryPort {
  /**
   * Retrieves the global settings for the creator portal.
   */
  getPortalSettings(): Promise<PortalSettings>;
}
