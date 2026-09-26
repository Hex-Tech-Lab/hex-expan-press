import { EsignProviderPort, EsignWebhookPort } from "../../domain/esign/esign.port.ts";
import { FirmaAdapter } from "./firma.adapter.ts";
import { EsignSettings } from "../../domain/settings/settings.port.ts";

export type EsignAdapter = EsignProviderPort & EsignWebhookPort;

export function createEsignAdapter(settings: EsignSettings): EsignAdapter {
  switch (settings.activeProvider.toLowerCase()) {
    case "firma":
      return new FirmaAdapter();
    // Add DocuSignAdapter, etc., here later
    default:
      console.warn(`Unknown esign provider '${settings.activeProvider}', falling back to firma.`);
      return new FirmaAdapter();
  }
}
