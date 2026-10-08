/**
 * polar.adapter.ts — Polar payment provider adapter
 *
 * Translates Polar's webhook payload into the Universal Language defined in payments.port.ts.
 * This is the SSOT for all Polar-specific field mappings, signature schemes, and event types.
 *
 * ADR: ADR-0050
 *
 * Signature scheme: Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature headers).
 * Polar supports two key derivations concurrently (whsec_-prefixed base64 and legacy UTF-8 HMAC).
 * Amount unit: cents (integer). No conversion needed.
 * Timestamp source: data.created_at (ISO-8601)
 * Email path: data.customer.email
 * Product ID path: data.product_id OR data.product.id
 * Attribution ID path: data.metadata.reference_id
 */
import { PaymentProviderPort, WebhookParseResult, CheckoutCommand, CheckoutResult, SaleCompletedEvent, RefundIssuedEvent } from "../../domain/payments/payments.port.ts";
import { z } from "zod";
import crypto from "crypto";
import { cleanAttributionId, hashEmail } from "../../../payments/src/provider.ts";
import { GLOBAL } from "../../../payments/src/settings_registry.ts";

// --- SSOT Schema (Zod) ---
const PolarSaleSchema = z.object({
  type: z.enum(["order.created", "order.paid"]),
  data: z.object({
    id: z.string(),
    product_id: z.string().optional(),
    product: z.object({ id: z.string() }).optional(),
    total_amount: z.number().int().nonnegative(), // cents
    currency: z.string().length(3),
    created_at: z.string().datetime(),
    customer: z.object({ email: z.string().email() }),
    paid: z.boolean().optional(),
    metadata: z.object({ reference_id: z.string().optional() }).optional().nullable()
  })
});

// Polar's Refund object always carries order_id and amounts in cents: `amount` is the
// refunded net (Polar caps refunds at the order's net amount, tax excluded) and
// `tax_amount` the tax refunded with it. Polar supports PARTIAL refunds, so both are
// REQUIRED here — a refund whose amount is missing or malformed fails schema
// validation (400) instead of reaching the ledger as an amount-less "full reversal".
// Safe-integer guard (Wave 7.3): refund amounts arrive as JSON numbers — a hostile
// or broken producer can send values beyond Number.MAX_SAFE_INTEGER where cents
// arithmetic silently loses precision. Cap amount and tax_amount individually AND
// their sum (the ledger's totalCents), so every refund value stays exact.
const PolarRefundDataSchema = z
  .object({
    id: z.string().min(1),
    order_id: z.string().min(1),
    amount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tax_amount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    created_at: z.string().datetime().optional()
  })
  .refine(
    (d) => d.amount + d.tax_amount <= Number.MAX_SAFE_INTEGER,
    { message: "amount + tax_amount exceeds Number.MAX_SAFE_INTEGER" }
  );
const PolarRefundSchema = z.object({
  type: z.literal("refund.created"),
  data: PolarRefundDataSchema
});

const PolarWebhookSchema = z.union([PolarSaleSchema, PolarRefundSchema]);

// Replay-window tolerance (sharp-edges audit 2026-10-01): a signed webhook
// delivery is only trusted within this many seconds of now; anything outside
// is a captured-then-replayed delivery and fails closed with 401.
export const POLAR_WEBHOOK_TOLERANCE_SECONDS = GLOBAL.payments.webhook_tolerance_seconds;

export class PolarAdapter implements PaymentProviderPort {
  readonly providerName = "polar";

  canHandleWebhook(headers: Record<string, string | string[] | undefined>): boolean {
    return Boolean(headers["webhook-signature"] && headers["webhook-id"] && headers["webhook-timestamp"]);
  }

  async parseAndValidateWebhook(headers: Record<string, string | string[] | undefined>, body: string): Promise<WebhookParseResult> {
    const secret = process.env.POLAR_WEBHOOK_SECRET;
    if (!secret) return { isValid: false, error: "POLAR_WEBHOOK_SECRET not configured", httpStatus: 500 };

    const signatureStr = headers["webhook-signature"] as string;
    const id = headers["webhook-id"] as string;
    const ts = headers["webhook-timestamp"] as string;

    if (!signatureStr || !id || !ts) {
      return { isValid: false, error: "Missing Polar Standard Webhook headers (webhook-id, webhook-timestamp, webhook-signature)", httpStatus: 401 };
    }

    // Replay window: Standard Webhooks stamps `webhook-timestamp` in SECONDS.
    // Reject non-integer stamps and anything outside the tolerance BEFORE
    // signature verification so a captured (validly signed) delivery cannot be
    // replayed later.
    const tsSeconds = Number(ts);
    if (!Number.isInteger(tsSeconds) || Math.abs(Math.floor(Date.now() / 1000) - tsSeconds) > POLAR_WEBHOOK_TOLERANCE_SECONDS) {
      return { isValid: false, error: `Webhook timestamp outside the ${POLAR_WEBHOOK_TOLERANCE_SECONDS}-second tolerance`, httpStatus: 401 };
    }

    // Polar supports two concurrent key derivations
    const b64part = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
    const swKey = Buffer.from(b64part, "base64");
    const keys = swKey.length > 0 ? [swKey, Buffer.from(secret, "utf8")] : [Buffer.from(secret, "utf8")];
    const signedContent = `${id}.${ts}.${body}`;
    const expectedSigs = keys.map((key) => crypto.createHmac("sha256", key).update(signedContent).digest());
    const providedSigs = signatureStr.split(" ").map(s => s.trim().replace(/^v1,/, "")).filter(Boolean).map(s => Buffer.from(s, "base64"));

    let valid = false;
    for (const got of providedSigs) {
      for (const exp of expectedSigs) {
        if (got.length === exp.length && crypto.timingSafeEqual(got, exp)) { valid = true; break; }
      }
    }
    if (!valid && process.env.NODE_ENV === "production") {
      return { isValid: false, error: "Invalid Polar signature", httpStatus: 401 };
    }

    try {
      const parsedJson = JSON.parse(body) as unknown;
      const validated = PolarWebhookSchema.parse(parsedJson);

      if (validated.type === "refund.created") {
        const event: RefundIssuedEvent = {
          eventType: "refund_issued",
          providerName: this.providerName,
          saleId: validated.data.order_id,
          refundId: validated.data.id,
          // Gross refunded = net + tax, comparable to the sale's total_amount (tax-inclusive).
          totalCents: validated.data.amount + validated.data.tax_amount,
          occurredAt: validated.data.created_at || new Date().toISOString(),
          rawPayload: parsedJson
        };
        return { isValid: true, event };
      }

      // order.created arrives for subscriptions in "pending" (unpaid) state — skip until order.paid
      if (validated.type === "order.created" && !validated.data.paid) {
        return { isValid: true, event: { eventType: "ignored", providerName: this.providerName, reason: "Unpaid order.created — awaiting order.paid" } };
      }

      const productId = validated.data.product_id || validated.data.product?.id;
      if (!productId) return { isValid: false, error: "Missing product_id in Polar payload", httpStatus: 400 };

      const event: SaleCompletedEvent = {
        eventType: "sale_completed",
        providerName: this.providerName,
        saleId: validated.data.id,
        productId,
        totalCents: validated.data.total_amount,
        currency: validated.data.currency.toUpperCase(),
        buyerEmailHash: hashEmail(validated.data.customer.email),
        occurredAt: validated.data.created_at,
        attributionId: cleanAttributionId(validated.data.metadata?.reference_id),
        rawPayload: parsedJson
      };
      return { isValid: true, event };

    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { isValid: false, error: `Schema validation failed: ${message}`, httpStatus: 400 };
    }
  }

  async createCheckout(command: CheckoutCommand): Promise<CheckoutResult> {
    return {
      checkoutUrl: `https://polar.sh/checkout/${command.productId}?email=${encodeURIComponent(command.buyerEmail)}`,
      providerName: this.providerName
    };
  }
}
