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
 *   - batch events (FastSpring multi-event): every action is forwarded — the first as
 *     `event`, the rest as `followingEvents` — and the engine processes each in order
 */
import { PaymentProviderPort, WebhookParseResult, CheckoutResult, BillingEvent } from "../../domain/payments/payments.port.ts";
import { cleanAttributionId, type CheckoutProvider, type SaleEvent, type RefundEvent } from "../../../payments/src/provider.ts";
import { getSecret } from "../../../payments/src/webhook_core.ts";
import { paymentProviderSetting } from "../../../payments/src/settings_registry.ts";

// Payhip signs in the payload (a top-level signature property), never in a header.
const PAYHIP_SIG_FIELD = String(paymentProviderSetting("payhip")?.signature_field ?? "signature");

function hasBodySignature(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>)[PAYHIP_SIG_FIELD] === "string";
  } catch {
    return false;
  }
}

export class LegacyPaymentAdapterWrapper implements PaymentProviderPort {
  readonly providerName: string;
  private legacyProvider: CheckoutProvider;

  constructor(provider: CheckoutProvider) {
    this.providerName = provider.name;
    this.legacyProvider = provider;
  }

  canHandleWebhook(headers: Record<string, string | string[] | undefined>, body: string): boolean {
    if (this.providerName === "payhip") return hasBodySignature(body);
    const knownSignatureHeaders: Record<string, string> = {
      lemonsqueezy: "x-signature",
      fastspring: "x-fs-signature",
      fungies: "x-fngs-signature"
    };
    const expectedHeader = knownSignatureHeaders[this.providerName];
    if (!expectedHeader) return true;
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

    const actions: ({ sale: SaleEvent } | { refund: RefundEvent })[] =
      "sale" in result ? [{ sale: result.sale }] : "refund" in result ? [{ refund: result.refund }] : result.batch;
    if (actions.length === 0) {
      return { isValid: false, error: "Legacy parse returned no usable event" };
    }

    // Every action of a multi-event delivery is forwarded; dropping any loses it for good (the
    // provider sees a 2xx). One unusable action fails the whole delivery so the provider retries.
    const rawPayload: unknown = JSON.parse(body);
    const events: BillingEvent[] = [];
    for (const action of actions) {
      const translated = this.translate(action, rawPayload);
      if ("error" in translated) return { isValid: false, error: translated.error, httpStatus: 400 };
      events.push(translated.event);
    }
    const [event, ...followingEvents] = events as [BillingEvent, ...BillingEvent[]];
    return { isValid: true, event, ...(followingEvents.length > 0 ? { followingEvents } : {}) };
  }

  private translate(action: { sale: SaleEvent } | { refund: RefundEvent }, rawPayload: unknown): { event: BillingEvent } | { error: string } {
    if ("refund" in action) {
      return {
        event: {
          eventType: "refund_issued",
          providerName: this.providerName,
          saleId: action.refund.sale_id,
          occurredAt: action.refund.ts,
          ...(action.refund.amount_unverifiable === true ? { amountUnverifiable: true } : {}),
          rawPayload,
        },
      };
    }
    const { sale } = action;
    // Book only the currency the provider verified; never stamp a default onto an unknown one.
    if (!sale.currency) return { error: "Legacy sale missing currency" };
    return {
      event: {
        eventType: "sale_completed",
        providerName: this.providerName,
        saleId: sale.sale_id,
        productId: sale.product_id,
        // Legacy adapters return amount_usd (float USD). Convert to cents.
        // TODO: migrate each provider to return integer cents natively.
        totalCents: Math.round(sale.amount_usd * 100),
        currency: sale.currency,
        buyerEmailHash: sale.email_hash,
        // Delivery needs the address: without it the engine refuses every non-Paddle sale with 422.
        buyerEmail: sale.buyer_email,
        attributionId: cleanAttributionId(sale.attribution_id),
        occurredAt: sale.ts,
        rawPayload,
      },
    };
  }

  async createCheckout(): Promise<CheckoutResult> {
    return { checkoutUrl: "", providerName: this.providerName };
  }
}
