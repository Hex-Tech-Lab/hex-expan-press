// paddle.ts — Paddle Billing webhook adapter. PENDING-KYC: adapter is wired and checked,
// but cannot be live-tested until the Paddle account (KYC cascade slot #1) exists.
//
// SIGNATURE (from memory): `Paddle-Signature: ts=<unix-seconds>;h1=<hmac>` where h1 is the
// HMAC-SHA256 hex digest of `<ts>:<raw-body>` keyed with the webhook secret. UNVERIFIED vs provider docs — verify before go-live.
//
// Payload shape (from memory): `{ event_type: "transaction.completed", data: { id, currency_code,
// details.totals.total (cents), custom_data.product_id, custom_data.email } }`. UNVERIFIED vs provider docs — verify before go-live.
//
// Provider literals (signature header, sale event, secret-env name, field map, currency gate)
// come from the settings registry (data/settings/providers.json + global.json) with inline
// fallbacks mirroring the committed registry — standalone runs behave identically.
import type { CheckoutProvider, ParseResult, ProviderName } from "../provider.ts";
import { hashEmail, hmacSha256Hex, safeEqualHex } from "../provider.ts";
import { getPath, isAllowedCurrency, paymentProviderSetting } from "../settings_registry.ts";

const NAME: ProviderName = "paddle";

const CFG = paymentProviderSetting(NAME);
const SIG_HEADER = String(CFG?.signature_header ?? "paddle-signature").toLowerCase(); // node lowercases header names
const SALE_EVENT = String(CFG?.sale_event ?? "transaction.completed");
const SECRET_ENV = String(CFG?.secret_env ?? "PADDLE_WEBHOOK_SECRET");
const FM = (CFG?.field_map ?? {}) as Record<string, string | undefined>;

export const paddleProvider: CheckoutProvider = {
  name: NAME,
  parseWebhook(headers, rawBody, secret): ParseResult {
    if (!secret) return { ok: false, status: 500, error: `provider not configured: missing ${SECRET_ENV}` };

    // UNVERIFIED vs provider docs — verify before go-live (Paddle-Signature ts=..;h1=.. format)
    const sigHeader = headers[SIG_HEADER];
    if (typeof sigHeader !== "string" || !sigHeader.includes(";")) {
      return { ok: false, status: 401, error: `missing/malformed ${SIG_HEADER} header` };
    }
    const parts = Object.fromEntries(
      sigHeader.split(";").map((kv) => kv.split("=", 2) as [string, string]),
    );
    const ts = parts["ts"];
    const h1 = parts["h1"];
    if (!ts || !h1) return { ok: false, status: 401, error: "missing ts/h1 in Paddle-Signature" };
    if (!safeEqualHex(hmacSha256Hex(secret, Buffer.from(`${ts}:${rawBody.toString("utf8")}`)), h1)) {
      return { ok: false, status: 401, error: "invalid signature" };
    }

    let body: any;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: false, status: 400, error: "invalid JSON body" };
    }

    // UNVERIFIED vs provider docs — verify before go-live (event_type name + data path)
    const eventType = body?.event_type;
    if (eventType !== SALE_EVENT) {
      return { ok: false, status: 202, error: `ignored non-sale event: ${eventType ?? "<none>"}` };
    }
    const data = body?.data;
    const productId = getPath(body, FM.product_id) ?? data?.custom_data?.product_id; // UNVERIFIED vs provider docs — verify before go-live
    const totalCents = Number(getPath(body, FM.total_cents) ?? data?.details?.totals?.total); // UNVERIFIED vs provider docs — verify before go-live
    const currency = String(getPath(body, FM.currency) ?? data?.currency_code ?? "").toUpperCase();
    const saleId = String(getPath(body, FM.sale_id) ?? data?.id ?? "");
    const email = getPath(body, FM.email) ?? data?.custom_data?.email; // UNVERIFIED vs provider docs — verify before go-live (Paddle redacts emails unless stored)
    const changeTs = Number(getPath(body, FM.ts_epoch_s) ?? data?.changed_at); // UNVERIFIED vs provider docs — epoch seconds
    // Our own canonical attribution ID (added 2026-09-18) — see field_map.attribution_id /
    // attribution_note in data/settings/providers.json. Server-side extraction only; client-side
    // checkout-link wiring to actually SET custom_data.attribution_id at checkout is not yet
    // built for Paddle (its JS overlay uses a customData init option, not a URL param).
    const attributionIdRaw = getPath(body, FM.attribution_id) ?? data?.custom_data?.attribution_id;
    const attributionId = typeof attributionIdRaw === "string" && attributionIdRaw !== "" ? attributionIdRaw : undefined;

    if (!productId) return { ok: false, status: 400, error: "missing custom_data.product_id (set it on the checkout)" };
    if (!saleId) return { ok: false, status: 400, error: "missing data.id" };
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
        ts: Number.isFinite(changeTs) && changeTs > 0 ? new Date(changeTs * 1000).toISOString() : new Date().toISOString(),
        email_hash: hashEmail(email),
        ...(attributionId ? { attribution_id: attributionId } : {}),
      },
    };
  },
};
