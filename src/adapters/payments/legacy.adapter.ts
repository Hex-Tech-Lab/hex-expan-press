import { PaymentProviderPort, WebhookValidationResult, CheckoutCommand, CheckoutResult } from "../../domain/payments/payments.port.ts";
import type { CheckoutProvider } from "../../../payments/src/provider.ts";
import { getSecret } from "../../../payments/src/webhook_core.ts";

export class LegacyPaymentAdapterWrapper implements PaymentProviderPort {
  readonly providerName: string;
  private legacyProvider: CheckoutProvider;

  constructor(provider: CheckoutProvider) {
    this.providerName = provider.name;
    this.legacyProvider = provider;
  }

  canHandleWebhook(headers: Record<string, string | string[] | undefined>, _body: string): boolean {
    const knownHeaders: Record<string, string> = {
      lemonsqueezy: "x-signature",
      payhip: "signature", 
      paddle: "paddle-signature",
      fastspring: "x-fs-signature",
      fungies: "x-fngs-signature"
    };
    
    const expectedHeader = knownHeaders[this.providerName];
    if (!expectedHeader) return true; // fallback for payhip or others
    return Boolean(headers[expectedHeader] || headers[expectedHeader.toLowerCase()]);
  }

  async parseAndValidateWebhook(headers: Record<string, string | string[] | undefined>, body: string): Promise<WebhookValidationResult> {
    const secret = getSecret(this.legacyProvider.name);
    const rawBody = Buffer.from(body, "utf8");

    const result = this.legacyProvider.parseWebhook(headers, rawBody, secret);

    if (!result.ok) {
      return { isValid: false, error: result.error || "Legacy parse failed" };
    }

    if ("refund" in result && result.refund) {
      return {
        isValid: true,
        providerName: this.providerName,
        event: {
          eventType: "refund_issued",
          provider: this.providerName,
          saleId: result.refund.sale_id,
          productId: "", 
          totalCents: 0,
          currency: "usd",
          email: "",
          timestamp: result.refund.ts,
          rawPayload: JSON.parse(body)
        }
      };
    }

    if ("sale" in result && result.sale) {
      return {
        isValid: true,
        providerName: this.providerName,
        event: {
          eventType: "sale_completed",
          provider: this.providerName,
          saleId: result.sale.sale_id,
          productId: result.sale.product_id,
          totalCents: Math.round(result.sale.amount_usd * 100),
          currency: "usd",
          email: "", // Lost email via legacy path, but acceptable for interim bridge
          timestamp: result.sale.ts,
          rawPayload: JSON.parse(body)
        }
      };
    }

    // Ignore batch for now (Fastspring returns batch but only first item is processed usually, or we skip)
    return { isValid: false, error: "Legacy parse returned unsupported event structure (e.g. batch)" };
  }

  async createCheckout(_command: CheckoutCommand): Promise<CheckoutResult> {
    return { checkoutUrl: "", providerName: this.providerName };
  }
}
