/**
 * paddle.adapter.ts — Paddle Billing provider adapter
 *
 * Environment isolation: each Paddle environment has its own webhook secret
 * and its own price ids; a sandbox-signed event fails the production secret,
 * and a sandbox price id is absent from the production PADDLE_PRICE_MAP.
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
 * Product ID path: mapped server-side via PADDLE_PRICE_MAP (items[].price.id)
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
    changed_at: z.string().datetime().optional(),
    customer_id: z.string().optional(),
    items: z.array(
      z.object({
        price: z.object({
          id: z.string()
        }).passthrough()
      }).passthrough()
    ).optional()
  })
});

export const PADDLE_WEBHOOK_TOLERANCE_SECONDS = 300;

export function loadPaddlePriceMap(
  raw: string | undefined = process.env.PADDLE_PRICE_MAP
): Record<string, string> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== "string") return null;
      result[k] = v;
    }
    return result;
  } catch {
    return null;
  }
}

export function paddleServerEnvironment(
  raw: string | undefined = process.env.PADDLE_ENVIRONMENT,
  vercelEnv: string | undefined = process.env.VERCEL_ENV
): "sandbox" | "production" | null {
  if (raw !== "sandbox" && raw !== "production") {
    return null;
  }
  if (vercelEnv === "production" && raw !== "production") {
    return null;
  }
  return raw;
}

export class PaddleAdapter implements PaymentProviderPort {
  readonly providerName = "paddle";

  canHandleWebhook(headers: Record<string, string | string[] | undefined>, _body: string): boolean {
    return Boolean(headers["paddle-signature"]);
  }

  async parseAndValidateWebhook(headers: Record<string, string | string[] | undefined>, body: string): Promise<WebhookParseResult> {
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    if (!secret) return { isValid: false, error: "PADDLE_WEBHOOK_SECRET not configured", httpStatus: 500 };

    const serverEnv = paddleServerEnvironment();
    if (!serverEnv) {
      return { isValid: false, error: "PADDLE_ENVIRONMENT missing, unknown, or sandbox in production", httpStatus: 500 };
    }

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

      const priceMap = loadPaddlePriceMap();
      if (priceMap === null) {
        return { isValid: false, error: "PADDLE_PRICE_MAP not configured", httpStatus: 500 };
      }

      const items = validated.data.items ?? [];
      if (items.length === 0) {
        return { isValid: false, error: "Unknown Paddle price", httpStatus: 400 };
      }

      const mappedProducts: string[] = [];
      for (const item of items) {
        const priceId = item.price.id;
        // Own-property lookup only: a price id like "constructor" must not resolve via Object.prototype.
        const mapped = Object.hasOwn(priceMap, priceId) ? priceMap[priceId] : undefined;
        if (typeof mapped !== "string" || mapped === "") {
          return { isValid: false, error: "Unknown Paddle price", httpStatus: 400 };
        }
        mappedProducts.push(mapped);
      }

      const distinctProducts = Array.from(new Set(mappedProducts));
      if (distinctProducts.length > 1) {
        return { isValid: false, error: "Mixed products in one transaction", httpStatus: 400 };
      }

      const productId = distinctProducts[0];
      const customProductId = validated.data.custom_data?.product_id;
      if (customProductId !== undefined && customProductId !== productId) {
        return { isValid: false, error: "custom_data.product_id does not match the paid price", httpStatus: 400 };
      }

      let email = validated.data.custom_data?.email;
      if (!email) {
        // Buyers type their email INTO the Paddle overlay, so custom_data.email
        // is usually absent — resolve it from the Paddle customer record.
        // Only verified payloads reach this lookup (signature + freshness passed).
        const customerId = validated.data.customer_id;
        if (!customerId) {
          return { isValid: false, error: "Missing custom_data.email in Paddle payload", httpStatus: 400 };
        }
        const base =
          serverEnv === "production"
            ? "https://api.paddle.com"
            : "https://sandbox-api.paddle.com";
        const apiKey = process.env.PADDLE_API_KEY;
        try {
          if (!apiKey) throw new Error("PADDLE_API_KEY not configured");
          const resp = await fetch(`${base}/customers/${encodeURIComponent(customerId)}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000)
          });
          const fetched = ((await resp.json()) as { data?: { email?: unknown } }).data;
          if (typeof fetched?.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fetched.email)) {
            email = fetched.email;
          }
        } catch {
          // fall through — handled below
        }
        if (!email) {
          console.error(`[paddle.adapter] customer email lookup failed customer_id=${customerId} env=${serverEnv}`);
          return { isValid: false, error: "Could not resolve buyer email from Paddle", httpStatus: 503 };
        }
      }

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
