import { PaymentProviderPort, WebhookValidationResult, CheckoutCommand, CheckoutResult } from "../../domain/payments/payments.port.ts";
import { z } from "zod";
import crypto from "crypto";

const PaddleWebhookSchema = z.object({
  event_type: z.string(),
  data: z.object({
    id: z.string(),
    currency_code: z.string().optional(),
    details: z.object({
      totals: z.object({
        total: z.number().optional() // assumed cents
      }).optional()
    }).optional(),
    custom_data: z.object({
      product_id: z.string().optional(),
      email: z.string().email().optional()
    }).optional().nullable(),
    changed_at: z.string().optional()
  })
});

export class PaddleAdapter implements PaymentProviderPort {
  readonly providerName = "paddle";

  canHandleWebhook(headers: Record<string, string | string[] | undefined>, _body: string): boolean {
    return Boolean(headers["paddle-signature"]);
  }

  async parseAndValidateWebhook(headers: Record<string, string | string[] | undefined>, body: string): Promise<WebhookValidationResult> {
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    if (!secret) return { isValid: false, error: "PADDLE_WEBHOOK_SECRET not configured" };

    const sigHeader = headers["paddle-signature"] as string;
    if (!sigHeader) return { isValid: false, error: "Missing Paddle signature header" };

    // Parse ts=...;h1=...
    const matchTs = sigHeader.match(/ts=([0-9]+)/);
    const matchH1 = sigHeader.match(/h1=([a-f0-9]+)/i);

    if (!matchTs || !matchH1) {
      return { isValid: false, error: "Malformed paddle-signature header" };
    }

    const ts = matchTs[1];
    const providedSig = matchH1[1];
    const signedPayload = `${ts}:${body}`;

    const expectedSig = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");

    if (process.env.NODE_ENV === "production" && !crypto.timingSafeEqual(Buffer.from(providedSig, "hex"), Buffer.from(expectedSig, "hex"))) {
      return { isValid: false, error: "Invalid Paddle signature" };
    }

    try {
      const parsedJson = JSON.parse(body);
      const validated = PaddleWebhookSchema.parse(parsedJson);

      // We only care about sale events in this adapter for now
      if (validated.event_type !== "transaction.completed") {
        return { isValid: false, error: `Ignored non-sale event: ${validated.event_type}` };
      }

      const productId = validated.data.custom_data?.product_id;
      if (!productId) return { isValid: false, error: "Missing custom_data.product_id in Paddle payload" };

      return {
        isValid: true,
        providerName: this.providerName,
        event: {
          eventType: "sale_completed",
          provider: this.providerName,
          saleId: validated.data.id,
          productId: productId,
          totalCents: validated.data.details?.totals?.total || 0,
          currency: validated.data.currency_code || "usd",
          email: validated.data.custom_data?.email || "",
          timestamp: validated.data.changed_at || new Date().toISOString(),
          rawPayload: parsedJson
        }
      };
    } catch (e: any) {
      return { isValid: false, error: `Schema validation failed: ${e.message}` };
    }
  }

  async createCheckout(command: CheckoutCommand): Promise<CheckoutResult> {
    return {
      checkoutUrl: `https://paddle.com/checkout/${command.productId}?email=${encodeURIComponent(command.email)}`,
      providerName: this.providerName
    };
  }
}
