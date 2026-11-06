/**
 * legacy.adapter.ts — Bridge adapter for providers not yet ported to Zod SSOT schemas
 *
 * Wraps the existing legacy CheckoutProvider implementations (lemonsqueezy, payhip,
 * fungies, fastspring) and translates their ParseResult into the Universal Language.
 *
 * This is a TRANSITIONAL adapter. Each wrapped provider MUST be migrated to its own
 * full adapter with a Zod SSOT schema. Track in ADR-0050.
 *
 * Known limitations of legacy path vs Universal Language:
 *   - buyerEmailHash: legacy providers pass email_hash (already hashed) — we preserve it
 *   - totalCents: legacy uses amount_usd (float) — converted to cents (may have rounding)
 *   - buyerEmail / attributionId: forwarded from the provider parse (attribution label
 *     shape-checked by cleanAttributionId; a bad label is dropped, never rejects the sale)
 *   - batch events (FastSpring multi-event): only first action processed; rest dropped
 */
import { PaymentProviderPort, WebhookParseResult, CheckoutResult, SaleCompletedEvent, RefundIssuedEvent } from "../../domain/payments/payments.port.ts";
import { cleanAttributionId, type CheckoutProvider, type SaleEvent, type RefundEvent } from "../../../payments/src/provider.ts";
import { getSecret } from "../../../payments/src/webhook_core.ts";

export class LegacyPaymentAdapterWrapper implements PaymentProviderPort {
  readonly providerName: string;
  private legacyProvider: CheckoutProvider;

  constructor(provider: CheckoutProvider) {
    this.providerName = provider.name;
    this.legacyProvider = provider;
  }

  canHandleWebhook(headers: Record<string, string | string[] | undefined>): boolean {
    const knownSignatureHeaders: Record<string, string> = {
      lemonsqueezy: "x-signature",
      payhip: "signature",
      fastspring: "x-fs-signature",
      fungies: "x-fngs-signature"
    };
    const expectedHeader = knownSignatureHeaders[this.providerName];
    if (!expectedHeader) return true; // Payhip uses body field for signature
    return Boolean(headers[expectedHeader] || headers[expectedHeader.toLowerCase()]);
  }

  async parseAndValidateWebhook(headers: Record<string, string | string[] | undefined>, body: string): Promise<WebhookParseResult> {
    const secret = getSecret(this.legacyProvider.name);
    const rawBody = Buffer.from(body, "utf8");
    const result = this.legacyProvider.parseWebhook(headers, rawBody, secret);

    if (!result.ok) {
      const status = result.status;
      const httpStatus = (status === 401 || status === 400 || status === 422 || status === 500)
        ? status as 400 | 401 | 422 | 500
        : undefined;
      // 202 means "ignored" — not an error, but also not a sale/refund
      if (status === 202) {
        return { isValid: true, event: { eventType: "ignored", providerName: this.providerName, reason: result.error || "Skipped by legacy adapter" } };
      }
      return { isValid: false, error: result.error || "Legacy parse failed", httpStatus };
    }

    // Extract first action from batch (FastSpring only)
    let action: { sale?: SaleEvent; refund?: RefundEvent } | null = null;
    if ("sale" in result && result.sale) {
      action = { sale: result.sale };
    } else if ("refund" in result && result.refund) {
      action = { refund: result.refund };
    } else if ("batch" in result && result.batch && result.batch.length > 0) {
      action = result.batch[0];
    }

    if (!action) {
      return { isValid: false, error: "Legacy parse returned no usable event" };
    }

    if ("refund" in action && action.refund) {
      const event: RefundIssuedEvent = {
        eventType: "refund_issued",
        providerName: this.providerName,
        saleId: action.refund.sale_id,
        occurredAt: action.refund.ts,
        ...(action.refund.amount_unverifiable === true ? { amountUnverifiable: true } : {}),
        rawPayload: JSON.parse(body)
      };
      return { isValid: true, event };
    }

    if ("sale" in action && action.sale) {
      // Book only the currency the provider verified; never stamp a default onto an unknown one.
      if (!action.sale.currency) {
        return { isValid: false, error: "Legacy sale missing currency", httpStatus: 400 };
      }
      const event: SaleCompletedEvent = {
        eventType: "sale_completed",
        providerName: this.providerName,
        saleId: action.sale.sale_id,
        productId: action.sale.product_id,
        // Legacy adapters return amount_usd (float USD). Convert to cents.
        // TODO: migrate each provider to return integer cents natively.
        totalCents: Math.round(action.sale.amount_usd * 100),
        currency: action.sale.currency,
        buyerEmailHash: action.sale.email_hash,
        // Delivery needs the address: without it the engine refuses every non-Paddle sale with 422.
        buyerEmail: action.sale.buyer_email,
        attributionId: cleanAttributionId(action.sale.attribution_id),
        occurredAt: action.sale.ts,
        rawPayload: JSON.parse(body)
      };
      return { isValid: true, event };
    }

    return { isValid: false, error: "Legacy parse returned unknown structure" };
  }

  async createCheckout(): Promise<CheckoutResult> {
    return { checkoutUrl: "", providerName: this.providerName };
  }
}
