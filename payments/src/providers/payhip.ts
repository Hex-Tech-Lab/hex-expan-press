// payhip.ts — adapter for Payhip webhook events (paid / refunded).
//
// VERIFIED vs provider docs 2026-09-16 (help.payhip.com/article/115-webhooks, updated 2026-07-22):
//   - Signature scheme: NOT a header HMAC. The payload carries a `signature` property equal to
//     sha256(Payhip API key) hex (docs' PHP: hash('sha256', $apiKey); API key = Settings >
//     Developer page -> we store it as PAYHIP_WEBHOOK_SECRET). Verification = constant-time
//     compare of sha256(secret) against body.signature. NOTE (docs-verified, inherent): the
//     signature covers the KEY, not the body — any payload with the correct static signature
//     verifies, so this authenticates the sender but not payload integrity. Documented posture:
//     implement per docs; loud UNVERIFIED-LIVE status until a real signed delivery is seen.
//   - Endpoint: configured in Payhip Settings > Developer (comma-separated URLs); events chosen
//     in dashboard. Non-200 replies are retried once an hour for up to 3 hours.
//   - Amounts: minor units — "all prices are in cents or pennies" (10 USD = 1000). price,
//     amount_refunded, stripe_fee, payhip_fee all minor units.
//   - `paid`: {id (transaction id), email, currency, price, items[] (product_id = Payhip product
//     id, i.e. the payment link), date (unix seconds), type: "paid", signature}.
//   - `refunded`: same shape + amount_refunded, date_refunded, date_created, type: "refunded".
//     Full refund iff amount_refunded === price; PARTIAL refunds are REFUSED loudly (ledger
//     event_type=refund is a full-reversal record — recording a partial as full would
//     under-report income).
//   - subscription.created / subscription.deleted: ignored (202) — no sale identity/amount.
//   - NO test/sandbox flag exists in the payload; production secret must never be configured on
//     a non-production store.
//
// Provider literals (signature field, sale/refund events, secret-env name, field map, currency
// gate) come from the settings registry (data/settings/providers.json) with inline fallbacks
// mirroring the committed registry — standalone runs behave identically.
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { CheckoutProvider, ParseResult, ProviderName } from "../provider.ts";
import { hashEmail, safeEqualHex } from "../provider.ts";
import { getPath, isAllowedCurrency, paymentProviderSetting } from "../settings_registry.ts";

const NAME: ProviderName = "payhip";

const CFG = paymentProviderSetting(NAME);
const SIG_FIELD = String(CFG?.signature_field ?? "signature");
const SALE_EVENTS: string[] = Array.isArray(CFG?.sale_events) && CFG.sale_events.length > 0
  ? CFG.sale_events.map(String)
  : ["paid"];
const REFUND_EVENTS: string[] = Array.isArray(CFG?.refund_events) && CFG.refund_events.length > 0
  ? CFG.refund_events.map(String)
  : ["refunded"];
const SECRET_ENV = String(CFG?.secret_env ?? "PAYHIP_WEBHOOK_SECRET");
const FM = (CFG?.field_map ?? {}) as Record<string, string | undefined>;

function isoTs(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000).toISOString();
    if (typeof v === "string" && v !== "" && !Number.isNaN(Date.parse(v))) return v;
  }
  return new Date().toISOString();
}

export const payhipProvider: CheckoutProvider = {
  name: NAME,
  parseWebhook(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string | undefined): ParseResult {
    if (!secret) return { ok: false, status: 500, error: `provider not configured: missing ${SECRET_ENV}` };

    let body: any;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: false, status: 400, error: "invalid JSON body" };
    }

    const providedSig = body?.[SIG_FIELD];
    if (typeof providedSig !== "string" || providedSig === "") {
      return { ok: false, status: 401, error: `missing ${SIG_FIELD} property in payload` };
    }
    if (!safeEqualHex(createHash("sha256").update(secret, "utf8").digest("hex"), providedSig.trim())) {
      return { ok: false, status: 401, error: "invalid signature" };
    }

    const eventName = typeof body?.type === "string" ? body.type : "<none>";
    const eventId = typeof body?.id === "string" && body.id !== "" ? body.id : "<none>";

    if (REFUND_EVENTS.includes(eventName)) {
      const saleId = String(getPath(body, FM.sale_id) ?? body?.id ?? "");
      const priceMinor = Number(getPath(body, FM.total_cents) ?? body?.price);
      const refundedMinor = Number(getPath(body, FM.refund_amount_minor) ?? body?.amount_refunded);
      if (!saleId) {
        return { ok: false, status: 400, error: "refunded event missing transaction id — refund cannot be linked to a recorded sale" };
      }
      if (!Number.isFinite(refundedMinor) || refundedMinor < 0) {
        return { ok: false, status: 400, error: "refunded event missing amount_refunded — cannot classify full vs partial refund" };
      }
      if (Number.isFinite(priceMinor) && refundedMinor !== priceMinor) {
        return { ok: false, status: 422, error: `partial refund (amount_refunded ${refundedMinor} of price ${priceMinor}) — ledger refund records are full reversals; partial refunds must be recorded manually` };
      }
      return {
        ok: true,
        refund: { provider: NAME, sale_id: saleId, ts: isoTs(getPath(body, FM.refund_ts_epoch_s), body?.date_refunded) },
      };
    }

    if (!SALE_EVENTS.includes(eventName)) {
      return { ok: false, status: 202, error: `ignored non-sale event: ${eventName}` };
    }

    const items: any[] = Array.isArray(body?.items) ? body.items : [];
    const productId = getPath(body, FM.product_id) ?? items[0]?.product_id;
    const totalMinor = Number(getPath(body, FM.total_cents) ?? body?.price);
    const currency = String(getPath(body, FM.currency) ?? body?.currency ?? "").toUpperCase();
    const saleId = String(getPath(body, FM.sale_id) ?? body?.id ?? "");
    const ts = isoTs(getPath(body, FM.ts_epoch_s), body?.date);
    const email = getPath(body, FM.email) ?? body?.email;

    if (!productId) return { ok: false, status: 400, error: "missing items[0].product_id" };
    if (!saleId) return { ok: false, status: 400, error: "missing transaction id" };
    if (!Number.isFinite(totalMinor) || totalMinor < 0) return { ok: false, status: 400, error: "invalid price (minor units)" };
    if (currency && !isAllowedCurrency(currency)) return { ok: false, status: 400, error: `unsupported currency: ${currency}` };
    if (typeof email !== "string" || !email.includes("@")) return { ok: false, status: 400, error: "missing buyer email" };

    return {
      ok: true,
      sale: {
        sale_id: saleId,
        provider: NAME,
        product_id: String(productId),
        amount_usd: Math.round(totalMinor) / 100,
        ts,
        email_hash: hashEmail(email),
      },
    };
  },
};
