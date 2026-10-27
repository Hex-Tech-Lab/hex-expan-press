// The two public origins. Kept in a module with no imports so the Edge runtime (web/proxy.ts) can read
// them, and so settings_registry.ts and the proxy share one literal per domain.
// site: the creator house and buyer delivery (ADR 0061). pay: the only provider-agnostic checkout origin.
export const DOMAINS = {
  site: "https://expanpress.com",
  pay: "https://pay.expanpress.com",
} as const;
