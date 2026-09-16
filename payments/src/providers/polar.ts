// polar.ts — adapter for Polar.sh order.created / order.paid webhooks.
// LIVE-VERIFIED 2026-09-14 against https://sandbox-api.polar.sh/v1 (OAT token): orgs list,
// product create/get (POST /v1/products/, price_amount in CENTS, one-time = omit recurring_interval),
// checkout-links create (POST /v1/checkout-links/, response carries `url`), and webhook-endpoint
// create/delete (POST/DELETE /v1/webhooks/endpoints — response carries `secret` (whsec_…) and the
// readOnly `uses_standard_webhook_signature` flag). Product DELETE does NOT exist in the API
// (HTTP 405 live-confirmed) — archive via PATCH /v1/products/{id} {"is_archived": true}.
//
// SIGNATURE (per docs.polar.sh/integrate/webhooks/endpoints + delivery, 2026-09-14): Standard
// Webhooks scheme. Headers: `webhook-id`, `webhook-timestamp`, `webhook-signature` (space-separated
// list of `v1,<base64 sig>`). Signed content: `${webhook-id}.${webhook-timestamp}.${raw_body}`,
// HMAC-SHA256, signature base64-encoded. Secrets created on/after 2026-09-08 00:00 UTC: key =
// base64-decoded secret (after the `whsec_` prefix). Older secrets ("legacy Polar HMAC"): key =
// UTF-8 bytes of the FULL `whsec_…` string. Polar's own SDKs try both keys — so do we.
//
// UNVERIFIED-WITH-REASON: the signature scheme could not be verified against a LIVE signed
// delivery in sandbox — that requires completing a real (sandbox) checkout payment, which this
// task forbids. Scheme is implemented from the documented spec (incl. the legacy-key rule from
// the same docs page) and passed a local self-test with both key derivations; re-verify with a
// real sandbox delivery (`polar listen` tunnel + order.paid) before go-live.
//
// Envelope (schema-verified in Polar's 2026-10 OpenAPI spec): {type, timestamp, api_version,
// data: <Order>} where Order has id, created_at, status, paid, total_amount (cents), currency
// (lowercase, e.g. "usd"), billing_reason, customer.email, product_id, product, metadata.
// product_id is NATIVE on the order — no checkout custom-data passthrough needed (config.json
// product_id should hold the Polar product UUID).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { CheckoutProvider, ParseResult, ProviderName } from "../provider.ts";
import { hashEmail } from "../provider.ts";
import { getPath, isAllowedCurrency, paymentProviderSetting } from "../settings_registry.ts";

const NAME = "polar" as ProviderName;

const CFG = paymentProviderSetting(NAME);
const SIG_HEADER = String(CFG?.signature_header ?? "webhook-signature").toLowerCase(); // node lowercases header names
const SALE_EVENTS: string[] = Array.isArray(CFG?.sale_events) && CFG.sale_events.length > 0
  ? CFG.sale_events.map(String)
  : ["order.created", "order.paid"];
const SECRET_ENV = String(CFG?.secret_env ?? "POLAR_WEBHOOK_SECRET");
const FM = (CFG?.field_map ?? {}) as Record<string, string | undefined>;

function parseSignatureHeader(header: string | undefined): string[] {
  if (typeof header !== "string" || !header) return [];
  return header
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.startsWith("v1,") ? part.slice(3) : part))
    .filter((part) => part.length > 0);
}

/** Constant-time compare of two byte buffers; safe against length leaks. */
function safeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify per Standard Webhooks spec (as Polar implements it): try BOTH documented key
 * derivations — Standard Webhooks (base64-decoded secret after the `whsec_` prefix) and
 * legacy Polar HMAC (UTF-8 bytes of the FULL secret string) — against every signature
 * listed in the space-separated `webhook-signature` header.
 */
function signatureValid(secret: string, headers: IncomingHttpHeaders, rawBody: Buffer): boolean {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  if (typeof id !== "string" || typeof ts !== "string" || !id || !ts) return false;
  const signedContent = `${id}.${ts}.${rawBody.toString("utf8")}`;
  const keys: Buffer[] = [];
  const b64part = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const swKey = Buffer.from(b64part, "base64");
  if (swKey.length > 0) keys.push(swKey); // Standard Webhooks derivation (secrets on/after 2026-09-08)
  keys.push(Buffer.from(secret, "utf8")); // legacy Polar HMAC derivation (pre-2026-09-08 secrets)
  const expected = keys.map((key) => createHmac("sha256", key).update(signedContent).digest());
  const provided = parseSignatureHeader(headers["webhook-signature"]);
  for (const sigB64 of provided) {
    const got = Buffer.from(sigB64, "base64");
    for (const exp of expected) {
      if (safeEqualBytes(exp, got)) return true;
    }
  }
  return false;
}

export const polarProvider: CheckoutProvider = {
  name: NAME,
  parseWebhook(headers, rawBody, secret): ParseResult {
    if (!secret) return { ok: false, status: 500, error: `provider not configured: missing ${SECRET_ENV}` };
    const sigHeader = headers[SIG_HEADER];
    if (typeof sigHeader !== "string" || !sigHeader) return { ok: false, status: 401, error: `missing ${SIG_HEADER} header` };
    if (typeof headers["webhook-id"] !== "string" || typeof headers["webhook-timestamp"] !== "string") {
      return { ok: false, status: 401, error: "missing webhook-id/webhook-timestamp headers" };
    }
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
    if (!SALE_EVENTS.includes(eventName)) {
      return { ok: false, status: 202, error: `ignored non-sale event: ${eventName ?? "<none>"}` };
    }
    // order.created can carry an UNPAID order (status "pending", e.g. subscription renewals) —
    // only record it if already paid; otherwise wait for order.paid (same order id, ledger dedups).
    if (eventName === "order.created" && body?.data?.paid !== true) {
      return { ok: false, status: 202, error: "ignored unpaid order.created (waiting for order.paid)" };
    }
    const order = body?.data;
    const productId = getPath(body, FM.product_id) ?? order?.product_id ?? order?.product?.id;
    const totalCents = Number(getPath(body, FM.total_cents) ?? order?.total_amount);
    const currency = String(getPath(body, FM.currency) ?? order?.currency ?? "").toUpperCase();
    const saleId = String(getPath(body, FM.sale_id) ?? order?.id ?? "");
    const ts =
      typeof getPath(body, FM.ts) === "string"
        ? (getPath(body, FM.ts) as string)
        : typeof order?.created_at === "string"
          ? order.created_at
          : typeof body?.timestamp === "string"
            ? body.timestamp
            : new Date().toISOString();
    const email = getPath(body, FM.email) ?? order?.customer?.email;

    if (!productId) return { ok: false, status: 400, error: "missing data.product_id" };
    if (!saleId) return { ok: false, status: 400, error: "missing data.id (order id)" };
    if (!Number.isFinite(totalCents) || totalCents < 0) return { ok: false, status: 400, error: "invalid total_amount" };
    if (currency && !isAllowedCurrency(currency)) return { ok: false, status: 400, error: `unsupported currency: ${currency}` };
    if (typeof email !== "string" || !email.includes("@")) return { ok: false, status: 400, error: "missing buyer email (data.customer.email)" };

    return {
      ok: true,
      sale: {
        sale_id: saleId,
        provider: NAME,
        product_id: String(productId),
        amount_usd: Math.round(totalCents) / 100, // total_amount is in CENTS (schema-verified 2026-10 spec)
        ts,
        email_hash: hashEmail(email),
      },
    };
  },
};
