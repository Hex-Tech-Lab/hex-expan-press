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
import { hashEmail } from "../../../payments/src/provider.ts";

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

const PolarRefundSchema = z.object({
  type: z.literal("refund.created"),
  data: z.object({
    id: z.string().optional(),
    order_id: z.string().optional(),
    created_at: z.string().datetime().optional()
  })
});

const PolarWebhookSchema = z.union([PolarSaleSchema, PolarRefundSchema]);
type PolarWebhook = z.infer<typeof PolarWebhookSchema>;

export class PolarAdapter implements PaymentProviderPort {
  readonly providerName = "polar";

  canHandleWebhook(headers: Record<string, string | string[] | undefined>, _body: string): boolean {
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
          saleId: validated.data.order_id || validated.data.id || "",
          refundId: validated.data.id,
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
        attributionId: validated.data.metadata?.reference_id || undefined,
        rawPayload: parsedJson
      };
      return { isValid: true, event };

    } catch (e: any) {
      return { isValid: false, error: `Schema validation failed: ${e.message}`, httpStatus: 400 };
    }
  }

  async createCheckout(command: CheckoutCommand): Promise<CheckoutResult> {
    return {
      checkoutUrl: `https://polar.sh/checkout/${command.productId}?email=${encodeURIComponent(command.buyerEmail)}`,
      providerName: this.providerName
    };
  }
}
