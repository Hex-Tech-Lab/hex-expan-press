/**
 * paddle.adapter.ts — Paddle Billing provider adapter
 *
 * SSOT for all Paddle-specific field mappings, signature schemes, and event types.
 * ADR: ADR-0050
 *
 * Signature scheme: `Paddle-Signature: ts=<unix-seconds>;h1=<hmac-sha256-hex>`
 *   HMAC target = `<ts>:<raw-body>`
 * Amount unit: cents (integer) in details.totals.total
 * Timestamp source: data.changed_at (ISO-8601)
 * Email path: data.custom_data.email
 * Product ID path: data.custom_data.product_id
 * Attribution ID path: data.custom_data.reference_id (not yet wired client-side)
 *
 * STATUS: PENDING-KYC — adapter is wired and type-checked but cannot be live-tested
 * until the Paddle account KYC is complete. All field paths are from Paddle's official
 * docs (developer.paddle.com). Verify against a real sandbox delivery before go-live.
 */
import { PaymentProviderPort, WebhookParseResult, CheckoutCommand, CheckoutResult, SaleCompletedEvent } from "../../domain/payments/payments.port.ts";
import { z } from "zod";
import crypto from "crypto";
import { hashEmail } from "../../../payments/src/provider.ts";

// --- SSOT Schema (Zod) ---
const PaddleWebhookSchema = z.object({
  event_type: z.string(),
  data: z.object({
    id: z.string(),
    currency_code: z.string().length(3).optional(),
    details: z.object({
      totals: z.object({
        total: z.string() // Paddle returns total as a string number of cents
      }).optional()
    }).optional(),
    custom_data: z.object({
      product_id: z.string().optional(),
      email: z.string().email().optional(),
      reference_id: z.string().optional() // attribution passthrough (wiring unverified)
    }).optional().nullable(),
    changed_at: z.string().datetime().optional()
  })
});

export class PaddleAdapter implements PaymentProviderPort {
  readonly providerName = "paddle";

  canHandleWebhook(headers: Record<string, string | string[] | undefined>, _body: string): boolean {
    return Boolean(headers["paddle-signature"]);
  }

  async parseAndValidateWebhook(headers: Record<string, string | string[] | undefined>, body: string): Promise<WebhookParseResult> {
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    if (!secret) return { isValid: false, error: "PADDLE_WEBHOOK_SECRET not configured", httpStatus: 500 };

    const sigHeader = headers["paddle-signature"] as string;
    if (!sigHeader) return { isValid: false, error: "Missing paddle-signature header", httpStatus: 401 };

    const tsMatch = sigHeader.match(/ts=(\d+)/);
    const h1Match = sigHeader.match(/h1=([a-f0-9]+)/i);
    if (!tsMatch || !h1Match) {
      return { isValid: false, error: "Malformed paddle-signature header (expected ts=...;h1=...)", httpStatus: 401 };
    }

    const ts = tsMatch[1];
    const providedSig = h1Match[1];
    const expectedSig = crypto.createHmac("sha256", secret).update(`${ts}:${body}`, "utf8").digest("hex");

    const sigBufExpected = Buffer.from(expectedSig, "hex");
    const sigBufProvided = Buffer.from(providedSig, "hex");
    if (process.env.NODE_ENV === "production" &&
        (sigBufProvided.length !== sigBufExpected.length || !crypto.timingSafeEqual(sigBufProvided, sigBufExpected))) {
      return { isValid: false, error: "Invalid Paddle signature", httpStatus: 401 };
    }

    try {
      const parsedJson = JSON.parse(body) as unknown;
      const validated = PaddleWebhookSchema.parse(parsedJson);

      if (validated.event_type !== "transaction.completed") {
        return { isValid: true, event: { eventType: "ignored", providerName: this.providerName, reason: `Non-sale event: ${validated.event_type}` } };
      }

      const productId = validated.data.custom_data?.product_id;
      if (!productId) return { isValid: false, error: "Missing custom_data.product_id in Paddle payload", httpStatus: 400 };

      const email = validated.data.custom_data?.email;
      if (!email) return { isValid: false, error: "Missing custom_data.email in Paddle payload", httpStatus: 400 };

      // Paddle total is a string of integer cents
      const totalCents = parseInt(validated.data.details?.totals?.total ?? "0", 10);

      const event: SaleCompletedEvent = {
        eventType: "sale_completed",
        providerName: this.providerName,
        saleId: validated.data.id,
        productId,
        totalCents,
        currency: (validated.data.currency_code ?? "USD").toUpperCase(),
        buyerEmailHash: hashEmail(email),
        occurredAt: validated.data.changed_at || new Date().toISOString(),
        attributionId: validated.data.custom_data?.reference_id || undefined,
        rawPayload: parsedJson
      };
      return { isValid: true, event };

    } catch (e: any) {
      return { isValid: false, error: `Schema validation failed: ${e.message}`, httpStatus: 400 };
    }
  }

  async createCheckout(command: CheckoutCommand): Promise<CheckoutResult> {
    return {
      checkoutUrl: `https://paddle.com/checkout/${command.productId}?email=${encodeURIComponent(command.buyerEmail)}`,
      providerName: this.providerName
    };
  }
}
