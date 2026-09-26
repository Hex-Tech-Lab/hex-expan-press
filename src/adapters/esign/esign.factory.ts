import { EsignProviderPort, EsignWebhookPort, CreateEnvelopeCommand, CreateEnvelopeResult, WebhookValidationResult } from "../../domain/esign/esign.port.ts";
import { FirmaAdapter } from "./firma.adapter.ts";
import { EsignSettings, ProviderStrategy } from "../../domain/settings/settings.port.ts";
import { MatrixRouter } from "../../infrastructure/matrix_router/matrix_router.ts";

export type EsignAdapter = EsignProviderPort & EsignWebhookPort;

class CompositeEsignAdapter implements EsignAdapter {
  constructor(
    private strategy: ProviderStrategy,
    private adapterMap: Map<string, EsignAdapter>
  ) {}

  private resolveAdapter(name: string): EsignAdapter {
    const adapter = this.adapterMap.get(name.toLowerCase());
    if (!adapter) throw new Error(`Provider ${name} is not registered in the factory.`);
    return adapter;
  }

  async createEnvelope(command: CreateEnvelopeCommand): Promise<CreateEnvelopeResult> {
    // Dimension 1: Pick primary using Matrix Router (Staggered Distribution)
    // We use a global context 'global_esign' because e-sign distribution doesn't strictly need to be per-product
    let primaryName: string;
    try {
       primaryName = await MatrixRouter.getNextProvider("esign", "global_esign", this.strategy.distribution);
    } catch (e) {
       console.warn("MatrixRouter failed, falling back to basic resolution:", e);
       primaryName = this.strategy.distribution[0].provider;
    }
    
    const primaryAdapter = this.resolveAdapter(primaryName);

    try {
      // Primary Execution
      return await primaryAdapter.createEnvelope(command);
    } catch (err) {
      console.error(`[CompositeRouter] Primary provider ${primaryName} failed:`, err);
      
      // Mark it down globally for 15 minutes!
      await MatrixRouter.markProviderDown("esign", "global_esign", primaryName).catch(() => {});

      // Dimension 2: Vertical Cascade / Fallbacks
      for (const fallbackName of this.strategy.fallbacks) {
        if (fallbackName === primaryName) continue;
        console.warn(`[CompositeRouter] Cascading to fallback provider: ${fallbackName}`);
        
        try {
          const fallbackAdapter = this.resolveAdapter(fallbackName);
          return await fallbackAdapter.createEnvelope(command);
        } catch (fallbackErr) {
          console.error(`[CompositeRouter] Fallback provider ${fallbackName} failed:`, fallbackErr);
        }
      }
      
      throw new Error(`All configured esign providers failed (Primary: ${primaryName}, Fallbacks: ${this.strategy.fallbacks.join(',')})`);
    }
  }

  parseAndValidateWebhook(body: string, headers: Record<string, string | string[] | undefined>): WebhookValidationResult {
    for (const adapter of this.adapterMap.values()) {
      const result = adapter.parseAndValidateWebhook(body, headers);
      if (result.isValid) return result;
    }
    return { isValid: false, error: "No provider could validate this webhook signature." };
  }
}

export function createEsignAdapter(settings: EsignSettings): EsignAdapter {
  const availableAdapters = new Map<string, EsignAdapter>();
  availableAdapters.set("firma", new FirmaAdapter());
  // availableAdapters.set("docusign", new DocusignAdapter());
  
  return new CompositeEsignAdapter(settings.strategy, availableAdapters);
}
