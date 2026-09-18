import type { IncomingHttpHeaders } from "node:http";
import type { CheckoutProvider, ParseResult, ProviderName } from "../provider.ts";
import { hashEmail, hmacSha256Hex, safeEqualHex } from "../provider.ts";
import { getPath, isAllowedCurrency, paymentProviderSetting } from "../settings_registry.ts";

const NAME: ProviderName = "fungies";

const CFG = paymentProviderSetting(NAME);
const SIG_HEADER = String(CFG?.signature_header ?? "x-fngs-signature").toLowerCase();
const SALE_EVENTS: string[] = Array.isArray(CFG?.sale_events) && CFG.sale_events.length > 0
  ? CFG.sale_events.map(String)
  : ["payment_success"];
const SECRET_ENV = String(CFG?.secret_env ?? "FUNGIES_WEBHOOK_SECRET");
const FM = (CFG?.field_map ?? {}) as Record<string, string | undefined>;

const SIG_PREFIX = "sha256_";
const CUSTOM_FIELD_KEY = String(FM.custom_fields_product_id ?? "product_id");

function signatureValid(secret: string, headers: IncomingHttpHeaders, rawBody: Buffer): boolean {
  const provided = headers[SIG_HEADER];
  if (typeof provided !== "string" || !provided) return false;
  const trimmed = provided.trim();
  const bare = trimmed.startsWith(SIG_PREFIX) ? trimmed.slice(SIG_PREFIX.length) : trimmed;
  return safeEqualHex(hmacSha256Hex(secret, rawBody), bare);
}

function firstDefined(...vals: unknown[]): unknown {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function isoTs(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
    if (typeof v === "string" && v !== "" && !Number.isNaN(Date.parse(v))) return v;
  }
  return new Date().toISOString();
}

const ATTRIBUTION_FIELD_KEY = String(FM.custom_fields_attribution_id ?? "attribution_id");

// Our own canonical attribution ID (added 2026-09-18) — see field_map.attribution_id /
// attribution_note in data/settings/providers.json. Server-side extraction only; client-side
// checkout-link wiring to actually SET this Fungies Custom Field is not yet built (Fungies
// custom fields are configured per-checkout-link in their dashboard/API, not a raw URL param).
function resolveAttributionId(items: any[]): string | undefined {
  for (const item of items) {
    const cf = item?.customFields;
    if (cf && typeof cf === "object" && !Array.isArray(cf)) {
      const v = (cf as Record<string, unknown>)[ATTRIBUTION_FIELD_KEY];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
  }
  return undefined;
}

function resolveProductId(body: any, items: any[]): unknown {
  for (const item of items) {
    const cf = item?.customFields;
    if (cf && typeof cf === "object" && !Array.isArray(cf)) {
      const v = (cf as Record<string, unknown>)[CUSTOM_FIELD_KEY];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
  }
  for (const item of items) {
    const internal = item?.product?.internalId;
    if (typeof internal === "string" && internal.trim() !== "") return internal;
  }
  for (const item of items) {
    const pid = item?.product?.id;
    if (typeof pid === "string" && pid.trim() !== "") return pid;
  }
  return undefined;
}

function currencyDecimalsOf(...vals: unknown[]): number {
  for (const v of vals) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 8) return v;
  }
  return 2;
}

export const fungiesProvider: CheckoutProvider = {
  name: NAME,
  parseWebhook(headers, rawBody, secret): ParseResult {
    if (!secret) return { ok: false, status: 500, error: `provider not configured: missing ${SECRET_ENV}` };
    const sig = headers[SIG_HEADER];
    if (typeof sig !== "string" || !sig) return { ok: false, status: 401, error: `missing ${SIG_HEADER} header` };
    if (!signatureValid(secret, headers, rawBody)) {
      return { ok: false, status: 401, error: "invalid signature" };
    }

    let body: any;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: false, status: 400, error: "invalid JSON body" };
    }

    const eventName = body?.type;
    const eventId = typeof body?.id === "string" && body.id !== "" ? body.id : "<none>";
    if (body?.testMode === true) {
      return {
        ok: false,
        status: 202,
        error: `testMode — not recorded (sandbox event type=${eventName ?? "<none>"} id=${eventId}; production secret must never record sandbox events)`,
      };
    }
    if (eventName === "payment_refunded") {
      const rdata = body?.data ?? {};
      const rpayment = rdata.payment;
      const rorder = rdata.order;
      const saleId = String(getPath(body, FM.sale_id) ?? rpayment?.id ?? rorder?.id ?? "");
      if (!saleId) {
        return { ok: false, status: 400, error: "payment_refunded missing data.payment.id — refund cannot be linked to a recorded sale" };
      }
      return { ok: true, refund: { provider: NAME, sale_id: saleId, ts: isoTs(getPath(body, FM.ts_ms), rpayment?.createdAt, rorder?.createdAt) } };
    }
    if (!SALE_EVENTS.includes(eventName)) {
      return { ok: false, status: 202, error: `ignored non-sale event: ${eventName ?? "<none>"}` };
    }

    const data = body?.data ?? {};
    const items: any[] = Array.isArray(data.items) ? data.items : [];
    const payment = data.payment;
    const order = data.order;

    const productId = resolveProductId(body, items);
    const totalMinor = Number(getPath(body, FM.total_cents) ?? payment?.value ?? order?.value);
    const currency = String(getPath(body, FM.currency) ?? payment?.currency ?? order?.currency ?? items[0]?.currency ?? "").toUpperCase();
    const saleId = String(getPath(body, FM.sale_id) ?? payment?.id ?? order?.id ?? "");
    const rawTs = firstDefined(getPath(body, FM.ts_ms), payment?.createdAt, order?.createdAt);
    const ts = isoTs(rawTs);
    const email = getPath(body, FM.email) ?? data.user?.email ?? data.customer?.email;
    const decimals = currencyDecimalsOf(payment?.currencyDecimals, order?.currencyDecimals);
    const attributionId = resolveAttributionId(items);

    if (!productId) return { ok: false, status: 400, error: "missing product identity (items[].customFields / product.internalId / product.id)" };
    if (!saleId) return { ok: false, status: 400, error: "missing data.payment.id (sale identity)" };
    if (!Number.isFinite(totalMinor) || totalMinor < 0) return { ok: false, status: 400, error: "invalid payment value (data.payment.value)" };
    if (currency && !isAllowedCurrency(currency)) return { ok: false, status: 400, error: `unsupported currency: ${currency}` };
    if (typeof email !== "string" || !email.includes("@")) return { ok: false, status: 400, error: "missing buyer email (data.user.email)" };

    return {
      ok: true,
      sale: {
        sale_id: saleId,
        provider: NAME,
        product_id: String(productId),
        amount_usd: Math.round(totalMinor) / 10 ** decimals,
        ts,
        email_hash: hashEmail(email),
        ...(attributionId ? { attribution_id: attributionId } : {}),
      },
    };
  },
};
