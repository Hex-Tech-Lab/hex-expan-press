// lemonsqueezy.ts — adapter for Lemon Squeezy order_created webhooks.
//
// SIGNATURE (per Lemon Squeezy docs, widely documented scheme): the `X-Signature` header
// is the HMAC-SHA256 hex digest of the RAW request body, keyed with the webhook signing secret.
//
// Payload shape: UNVERIFIED vs provider docs — verify before go-live (esp. `meta.custom_data`
// passthrough and cents-denominated `total`). We require the checkout URL to carry the registry
// `checkout_param` (`?checkout[custom][product_id]=<product_id>`) so the webhook maps back to our
// settings file.
//
// Provider literals (signature header, sale event, secret-env name, field map, currency gate)
// come from the settings registry (data/settings/providers.json + global.json) with inline
// fallbacks mirroring the committed registry — standalone runs behave identically.
import type { CheckoutProvider, ParseResult, ProviderName } from "../provider.ts";
import { hashEmail, hmacSha256Hex, safeEqualHex } from "../provider.ts";
import { getPath, isAllowedCurrency, paymentProviderSetting } from "../settings_registry.ts";

const NAME: ProviderName = "lemonsqueezy";

const CFG = paymentProviderSetting(NAME);
const SIG_HEADER = String(CFG?.signature_header ?? "x-signature").toLowerCase(); // node lowercases header names
const SALE_EVENT = String(CFG?.sale_event ?? "order_created");
const SECRET_ENV = String(CFG?.secret_env ?? "LEMONSQUEEZY_WEBHOOK_SECRET");
const FM = (CFG?.field_map ?? {}) as Record<string, string | undefined>;

export const lemonsqueezyProvider: CheckoutProvider = {
  name: NAME,
  parseWebhook(headers, rawBody, secret): ParseResult {
    if (!secret) return { ok: false, status: 500, error: `provider not configured: missing ${SECRET_ENV}` };
    const sig = headers[SIG_HEADER];
    if (typeof sig !== "string" || !sig) return { ok: false, status: 401, error: `missing ${SIG_HEADER} header` };
    if (!safeEqualHex(hmacSha256Hex(secret, rawBody), sig)) {
      return { ok: false, status: 401, error: "invalid signature" };
    }

    let body: any;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: false, status: 400, error: "invalid JSON body" };
    }

    const eventName = body?.meta?.event_name;
    if (eventName !== SALE_EVENT) {
      return { ok: false, status: 202, error: `ignored non-sale event: ${eventName ?? "<none>"}` };
    }
    const attrs = body?.data?.attributes;
    const productId = getPath(body, FM.product_id) ?? body?.meta?.custom_data?.product_id;
    const totalCents = Number(getPath(body, FM.total_cents) ?? attrs?.total);
    const currency = String(getPath(body, FM.currency) ?? attrs?.currency ?? "").toUpperCase();
    const saleId = String(getPath(body, FM.sale_id) ?? body?.data?.id ?? attrs?.identifier ?? "");
    const createdAt = getPath(body, FM.ts) ?? attrs?.created_at;
    const email = getPath(body, FM.email) ?? attrs?.user_email;
    // Our own canonical attribution ID (added 2026-09-18) — see field_map.attribution_id /
    // attribution_note in data/settings/providers.json. Server-side extraction only; client-side
    // checkout-link wiring to actually SET meta.custom_data.attribution_id (via the analogous
    // checkout[custom][attribution_id] URL param) is not yet built.
    const attributionIdRaw = getPath(body, FM.attribution_id) ?? body?.meta?.custom_data?.attribution_id;
    const attributionId = typeof attributionIdRaw === "string" && attributionIdRaw !== "" ? attributionIdRaw : undefined;

    if (!productId) return { ok: false, status: 400, error: "missing meta.custom_data.product_id (set it in the checkout URL)" };
    if (!saleId) return { ok: false, status: 400, error: "missing sale id" };
    if (!Number.isFinite(totalCents) || totalCents < 0) return { ok: false, status: 400, error: "invalid total" };
    if (currency && !isAllowedCurrency(currency)) return { ok: false, status: 400, error: `unsupported currency: ${currency}` };
    if (typeof email !== "string" || !email.includes("@")) return { ok: false, status: 400, error: "missing buyer email" };

    return {
      ok: true,
      sale: {
        sale_id: saleId,
        provider: NAME,
        product_id: String(productId),
        amount_usd: Math.round(totalCents) / 100, // UNVERIFIED vs provider docs — confirm cents denomination
        ts: typeof createdAt === "string" ? createdAt : new Date().toISOString(),
        email_hash: hashEmail(email),
        ...(attributionId ? { attribution_id: attributionId } : {}),
      },
    };
  },
};
