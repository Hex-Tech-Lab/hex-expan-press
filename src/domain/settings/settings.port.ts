// 2D Provider Routing Strategy
export interface ProviderRoute {
  provider: string;
  weight: number; // For Horizontal Distribution (e.g., A/B testing or load balancing)
}

export interface ProviderStrategy {
  mode: 'single' | 'distribute' | 'cascade' | '2d';
  distribution: ProviderRoute[]; // Horizontal: pick one based on weight/round-robin
  fallbacks: string[];           // Vertical: if the picked one fails, cascade down this list
}

export interface EsignSettings {
  strategy: ProviderStrategy;
  revenueSplitTemplateId: string;
}

export interface PaymentsSettings {
  checkoutStrategy: ProviderStrategy;
}

export interface PortalSettings {
  esign: EsignSettings;
  payments: PaymentsSettings;
}

export interface SettingsRegistryPort {
  getPortalSettings(): Promise<PortalSettings>;
}
