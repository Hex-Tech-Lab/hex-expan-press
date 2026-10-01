/**
 * paddle.adapter.ts — Paddle Billing provider adapter
 *
 * SSOT for all Paddle-specific field mappings, signature schemes, and event types.
 * ADR: ADR-0050
 *
 * Signature scheme: `Paddle-Signature: ts=<unix-seconds>;h1=<hmac-sha256-hex>`
 *   HMAC target = `<ts>:<raw-body>`
 *   h1 must be exactly 64 hex chars; multiple h1 values (secret rotation)
 *   are accepted when ANY valid-format one matches. Timestamp freshness is
 *   enforced BEFORE HMAC verification (5-minute tolerance, fail-closed).
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

export const PADDLE_WEBHOOK_TOLERANCE_SECONDS = 300;

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

    const tsMatch = sigHeader.match(/(?:^|;)\s*ts=([^;]+)/);
    if (!tsMatch || !/h1=/.test(sigHeader)) {
      return { isValid: false, error: "Malformed paddle-signature header (expected ts=...;h1=...)", httpStatus: 401 };
    }

    // Freshness BEFORE HMAC: a non-integer or stale ts never reaches signature
    // verification (replay-window fail-closed, mirrors POLAR_WEBHOOK_TOLERANCE_SECONDS).
    const ts = tsMatch[1].trim();
    const tsSeconds = Number(ts);
    if (!Number.isInteger(tsSeconds) || Math.abs(Math.floor(Date.now() / 1000) - tsSeconds) > PADDLE_WEBHOOK_TOLERANCE_SECONDS) {
      return { isValid: false, error: "Webhook timestamp outside the 5-minute tolerance", httpStatus: 401 };
    }

    // h1 candidates: capture up to the next ';' or end, then require exactly
    // 64 hex chars (Buffer.from(hex) silently truncates junk). Paddle sends
    // multiple h1 values during secret rotation (`ts=..;h1=a;h1=b`) — accept
    // when ANY valid-format candidate matches, compared constant-time.
    const expectedSig = crypto.createHmac("sha256", secret).update(`${ts}:${body}`, "utf8").digest("hex");
    const sigBufExpected = Buffer.from(expectedSig, "hex");
    let signatureValid = false;
    for (const match of sigHeader.matchAll(/h1=([^;]+)/g)) {
      const provided = match[1].trim();
      if (!/^[0-9a-f]{64}$/i.test(provided)) continue;
      const sigBufProvided = Buffer.from(provided, "hex");
      if (crypto.timingSafeEqual(sigBufProvided, sigBufExpected)) {
        signatureValid = true;
        break;
      }
    }
    if (!signatureValid) {
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
