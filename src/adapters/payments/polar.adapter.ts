import { PaymentProviderPort, WebhookValidationResult, CheckoutCommand, CheckoutResult } from "../../domain/payments/payments.port.ts";
import { z } from "zod";
import crypto from "crypto";
import type { IncomingHttpHeaders } from "node:http";

const PolarWebhookSchema = z.object({
  type: z.enum(["order.created", "order.paid", "refund.created"]),
  data: z.object({
    id: z.string().optional(),
    order_id: z.string().optional(), // For refunds
    product_id: z.string().optional(),
    product: z.object({ id: z.string() }).optional(),
    total_amount: z.number().optional(), // cents
    currency: z.string().optional(),
    created_at: z.string().optional(),
    customer: z.object({
      email: z.string().email()
    }).optional(),
    paid: z.boolean().optional(),
    metadata: z.object({
      reference_id: z.string().optional()
    }).optional().nullable()
  })
});

export class PolarAdapter implements PaymentProviderPort {
  readonly providerName = "polar";

  canHandleWebhook(headers: Record<string, string | string[] | undefined>, _body: string): boolean {
    return Boolean(headers["webhook-signature"]);
  }

  async parseAndValidateWebhook(headers: Record<string, string | string[] | undefined>, body: string): Promise<WebhookValidationResult> {
    const secret = process.env.POLAR_WEBHOOK_SECRET;
    if (!secret) return { isValid: false, error: "POLAR_WEBHOOK_SECRET not configured" };

    const signatureStr = headers["webhook-signature"] as string;
    const id = headers["webhook-id"] as string;
    const ts = headers["webhook-timestamp"] as string;

    if (!signatureStr || !id || !ts) {
      return { isValid: false, error: "Missing Polar webhook signature headers" };
    }

    const rawBuffer = Buffer.from(body, "utf8");
    const signedContent = `${id}.${ts}.${body}`;
    
    // Polar supports standard webhooks & legacy HMAC
    const b64part = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
    const swKey = Buffer.from(b64part, "base64");
    const keys = swKey.length > 0 ? [swKey, Buffer.from(secret, "utf8")] : [Buffer.from(secret, "utf8")];
    
    const expected = keys.map((key) => crypto.createHmac("sha256", key).update(signedContent).digest());
    const provided = signatureStr.split(" ").map(s => s.trim().replace(/^v1,/, "")).filter(Boolean).map(s => Buffer.from(s, "base64"));
    
    let valid = false;
    for (const got of provided) {
      for (const exp of expected) {
        if (got.length === exp.length && crypto.timingSafeEqual(got, exp)) {
          valid = true;
          break;
        }
      }
    }
    
    if (!valid && process.env.NODE_ENV === "production") return { isValid: false, error: "Invalid Polar signature" };

    try {
      const parsedJson = JSON.parse(body);
      const validated = PolarWebhookSchema.parse(parsedJson);

      if (validated.type === "refund.created") {
        return {
          isValid: true,
          providerName: this.providerName,
          event: {
            eventType: "refund_issued",
            provider: this.providerName,
            saleId: validated.data.order_id || validated.data.id || "",
            productId: "", // Usually irrelevant for our ledger refund
            totalCents: 0, 
            currency: "",
            email: "",
            timestamp: validated.data.created_at || new Date().toISOString(),
            rawPayload: parsedJson
          }
        };
      }

      if (validated.type === "order.created" && !validated.data.paid) {
        return { isValid: false, error: "Ignored unpaid order.created event" };
      }

      const productId = validated.data.product_id || validated.data.product?.id;
      if (!productId) return { isValid: false, error: "Missing product ID in Polar payload" };

      return {
        isValid: true,
        providerName: this.providerName,
        event: {
          eventType: "sale_completed",
          provider: this.providerName,
          saleId: validated.data.id || "",
          productId: productId,
          totalCents: validated.data.total_amount || 0,
          currency: validated.data.currency || "usd",
          email: validated.data.customer?.email || "",
          timestamp: validated.data.created_at || new Date().toISOString(),
          rawPayload: parsedJson
        }
      };

    } catch (e: any) {
      return { isValid: false, error: `Schema validation failed: ${e.message}` };
    }
  }

  async createCheckout(command: CheckoutCommand): Promise<CheckoutResult> {
    // Note: To be fully decoupled, we'd hit the Polar API here to generate the checkout session.
    // For now, this returns a mock or placeholder until we migrate the checkout API.
    return {
      checkoutUrl: `https://polar.sh/checkout/${command.productId}?email=${encodeURIComponent(command.email)}`,
      providerName: this.providerName
    };
  }
}
