// Creem adapter (ADR 0061 rail behind pay.expanpress.com). Verification and parsing use Creem's official SDK
// (`creem/webhooks`), not hand-written signature code. The SDK returns { type, data, raw, id, createdAt }:
// `type` is the event name, `data` is the event object, `raw` is the original JSON body.
// Test-mode deliveries (mode === "test") are refused (400) unless `creemTestModeAllowed` passes (`accept` enabled
// AND `SUPABASE_URL` hostname equals `${databaseRef}.supabase.co`), in which case `creemProviderMode` maps "test" to "sandbox".
import { z } from "zod";
import { constructWebhookEvent, WebhookVerificationError } from "creem/webhooks";
import { cleanAttributionId, hashEmail } from "../../../payments/src/provider.ts";
import { GLOBAL, readProviderField } from "../../../payments/src/settings_registry.ts";
import type { PaymentProviderPort, WebhookParseResult, CheckoutCommand, CheckoutResult, SaleCompletedEvent, ProviderMode } from "../../domain/payments/payments.port.ts";

/** Test-mode gate. Test events are accepted only when the flag is on AND the database they would write to is the
 *  configured test branch. Any other combination refuses. This is why the flag alone is never enough. */
export interface CreemTestModeGate {
  accept: boolean;
  databaseRef: string;
  supabaseUrl: string | undefined;
}

export function creemTestModeAllowed(gate: CreemTestModeGate): boolean {
  if (!gate.accept) return false;
  if (!gate.databaseRef || !gate.supabaseUrl) return false;
  // Exact host match: a substring test would accept any host that merely contains the ref.
  try {
    return new URL(gate.supabaseUrl).hostname === `${gate.databaseRef}.supabase.co`;
  } catch {
    return false;
  }
}

const CreemCheckoutDataSchema = z.object({
  mode: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  order: z.object({
    id: z.string().min(1),
    status: z.string(),
    amount: z.number().int().nonnegative(),
    amount_paid: z.number().int().nonnegative().optional(),
    currency: z.string().min(3),
    product: z.string().min(1),
    mode: z.string().optional(),
  }),
  // Shape only, never format: a paid sale must not be refused on the email's syntax. This schema refuses an address under
  // 3 characters before booking (400, quarantined). A longer malformed address is booked; the mail provider refuses it on
  // send, and delivery answers 422 and quarantines the event, with the sale kept.
  customer: z.object({ email: z.string().min(3) }),
});

/**
 * Creem's own mode field: `mode` is "live" or "test" on the checkout object and on the order. Both must agree when both are
 * present. A missing or conflicting value returns undefined, and the sale is refused. "test" maps to the sandbox mode.
 */
export function creemProviderMode(data: { mode?: string; order: { mode?: string } }): ProviderMode | undefined {
  const modes = [data.mode, data.order.mode].filter((m): m is string => m !== undefined);
  if (modes.length === 0 || new Set(modes).size !== 1) return undefined;
  if (modes[0] === "live") return "live";
  if (modes[0] === "test") return "sandbox";
  return undefined;
}

export class CreemAdapter implements PaymentProviderPort {
  readonly providerName = "creem";
  private readonly testMode: CreemTestModeGate;

  constructor(testMode?: Partial<CreemTestModeGate>) {
    this.testMode = {
      accept: testMode?.accept ?? GLOBAL.payments.creem_accept_test_mode,
      databaseRef: testMode?.databaseRef ?? GLOBAL.payments.creem_test_database_ref,
      supabaseUrl: testMode && "supabaseUrl" in testMode ? testMode.supabaseUrl : process.env.SUPABASE_URL,
    };
  }

  /** Header-only check: a Creem delivery always carries the creem-signature header. */
  canHandleWebhook(headers: Record<string, string | string[] | undefined>): boolean {
    return Boolean(headers["creem-signature"]);
  }

  async parseAndValidateWebhook(headers: Record<string, string | string[] | undefined>, body: string): Promise<WebhookParseResult> {
    const secret = process.env.CREEM_WEBHOOK_SECRET;
    if (!secret) return { isValid: false, error: "CREEM_WEBHOOK_SECRET not configured", httpStatus: 500 };

    let verified: Awaited<ReturnType<typeof constructWebhookEvent>>;
    try {
      // Official SDK: verifies the creem-signature HMAC over the raw body, then parses it.
      verified = await constructWebhookEvent(body, headers as Record<string, string>, { secret });
    } catch (e: unknown) {
      if (e instanceof WebhookVerificationError) {
        return { isValid: false, error: "Invalid Creem signature", httpStatus: 401 };
      }
      if (e instanceof SyntaxError) {
        return { isValid: false, error: "Schema validation failed: body is not valid JSON", httpStatus: 400 };
      }
      console.error("[creem-adapter] internal error while verifying a delivery:", e);
      return { isValid: false, error: "Internal Creem adapter error", httpStatus: 500 };
    }

    const eventType = verified.type;
    if (eventType !== "checkout.completed") {
      // Refunds and disputes are money events with no mapping yet. Refuse them loudly (422), never ignore them silently.
      if (eventType === "refund.created" || eventType === "dispute.created") {
        return { isValid: false, error: `${eventType} is not mapped for Creem yet; manual review`, httpStatus: 422 };
      }
      return { isValid: true, event: { eventType: "ignored", providerName: this.providerName, reason: `Creem ${eventType} not used` } };
    }

    const parsed = CreemCheckoutDataSchema.safeParse(verified.data);
    if (!parsed.success) return { isValid: false, error: "Schema validation failed: checkout.completed shape", httpStatus: 400 };

    const data = parsed.data;
    // Test-mode payloads are refused unless the test gate is open (flag on AND the test database). Live is unaffected.
    if (data.mode === "test" || data.order.mode === "test") {
      if (!creemTestModeAllowed(this.testMode)) {
        if (this.testMode.accept) console.error("[creem-adapter] test-mode flag is on but the database is not the configured test branch; refusing");
        return { isValid: false, error: "Creem test-mode delivery refused", httpStatus: 400 };
      }
    }
    if (data.order.status !== "paid") {
      return { isValid: true, event: { eventType: "ignored", providerName: this.providerName, reason: "Creem checkout not paid" } };
    }

    // Checked before formatting: toISOString() throws RangeError on an out-of-range or non-finite time, which would turn a
    // signed malformed delivery into an uncaught 500 (a retry loop). Invalid time is a terminal 400.
    const occurred = typeof verified.createdAt === "number" ? new Date(verified.createdAt) : undefined;
    if (occurred === undefined || !Number.isFinite(occurred.getTime())) {
      return { isValid: false, error: "Creem delivery has no event time", httpStatus: 400 };
    }
    // Extract mapped fields through PAYMENT_PROVIDERS.creem.field_map (shared getPath helper)
    // after Zod validation confirms shape. product_id resolves from order.product, never metadata.
    const envelope = { data };
    const mappedProductId = readProviderField(envelope, this.providerName, "product_id");
    const mappedSaleId = readProviderField(envelope, this.providerName, "sale_id");
    const mappedPaidCents = readProviderField(envelope, this.providerName, "total_cents");
    const mappedFallbackCents = readProviderField(envelope, this.providerName, "total_cents_fallback");
    const mappedCurrency = readProviderField(envelope, this.providerName, "currency");
    const mappedEmail = readProviderField(envelope, this.providerName, "email");
    const mappedAttribution = readProviderField(envelope, this.providerName, "attribution_id");

    const productId = typeof mappedProductId === "string" && mappedProductId !== "" ? mappedProductId : data.order.product;
    const saleId = typeof mappedSaleId === "string" && mappedSaleId !== "" ? mappedSaleId : data.order.id;
    const totalCents =
      typeof mappedPaidCents === "number"
        ? mappedPaidCents
        : typeof mappedFallbackCents === "number"
          ? mappedFallbackCents
          : (data.order.amount_paid ?? data.order.amount);
    const currency = (typeof mappedCurrency === "string" && mappedCurrency !== "" ? mappedCurrency : data.order.currency).toUpperCase();
    const buyerEmail = typeof mappedEmail === "string" && mappedEmail !== "" ? mappedEmail : data.customer.email;

    const event: SaleCompletedEvent = {
      eventType: "sale_completed",
      providerName: this.providerName,
      saleId,
      productId,
      totalCents,
      currency,
      buyerEmailHash: hashEmail(buyerEmail),
      buyerEmail,
      occurredAt: occurred.toISOString(),
      attributionId: cleanAttributionId(mappedAttribution),
      providerMode: creemProviderMode(data),
      rawPayload: verified.raw,
    };
    return { isValid: true, event };
  }

  /** Creem checkouts are stored per product in product_rails (static links). The live route does not call this. */
  async createCheckout(_command: CheckoutCommand): Promise<CheckoutResult> {
    throw new Error("Creem checkout URLs come from product_rails; createCheckout is not used on the buy path");
  }
}
