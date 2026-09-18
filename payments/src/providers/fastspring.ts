// fastspring.ts — adapter for FastSpring server webhooks (order.completed / return.created).
//
// VERIFIED vs provider docs 2026-09-16 (developer.fastspring.com, llms-indexed):
//   - Signature (developer.fastspring.com/reference/message-security): `X-FS-Signature` header =
//     base64(HMAC-SHA256(RAW request body, secret)) — secret is the "HMAC SHA256 Secret" set on
//     the webhook URL endpoint (Developer Tools > Webhooks > Configuration). Header name case
//     varies; node lowercases. Optional per docs — but we REQUIRE a secret: unauthenticated
//     sales are refused (500 without FASTSPRING_WEBHOOK_SECRET, 401 on mismatch).
//   - Envelope (reference/webhooks-overview): `{events: [{id, live, processed, type, created
//     (unix ms), data}]}` — ONE POST MAY CARRY MULTIPLE EVENTS. Automatic retries reuse the same
//     event id; handlers must dedupe (ledger findSale/findRefund does, per sale_id).
//   - order.completed (reference/ordercompleted): data = order object {id, reference, total
//     (MAJOR units — dollars number, not cents), currency, customer.email, items[].product
//     (product path), changed (ms), live}. Fires only after payment + fulfillment; for
//     subscriptions fires on the INITIAL purchase only (rebills → subscription.charge.completed).
//   - return.created (reference/returncreated): data = {return (id), original.order (= the
//     original order id → sale linkage), original.total, totalReturn, changed, live, type:
//     RETURN|ALERT|CHARGEBACK}. PARTIAL refunds (totalReturn < original.total) are REFUSED
//     loudly — ledger event_type=refund is a full-reversal record; recording a partial as full
//     would under-report income.
//   - Test gate: data.live === false → 202, never recorded (webhook container can be configured
//     live/test/both; production secret must never record test orders) — same posture as the
//     Fungies testMode gate.
//   - JSON mode is the default (XML notification service is the legacy alternative — we accept
//     JSON only).
//
// Provider literals (signature header, sale/refund events, live-gate path, secret-env name,
// field map, currency gate) come from the settings registry (data/settings/providers.json) with
// inline fallbacks mirroring the committed registry — standalone runs behave identically.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { CheckoutProvider, ParseResult, ProviderName, RefundEvent, SaleEvent } from "../provider.ts";
import { hashEmail } from "../provider.ts";
import { getPath, isAllowedCurrency, paymentProviderSetting } from "../settings_registry.ts";

const NAME = "fastspring" as ProviderName;

const CFG = paymentProviderSetting(NAME);
const SIG_HEADER = String(CFG?.signature_header ?? "x-fs-signature").toLowerCase(); // node lowercases header names
const SALE_EVENTS: string[] = Array.isArray(CFG?.sale_events) && CFG.sale_events.length > 0
  ? CFG.sale_events.map(String)
  : ["order.completed"];
const REFUND_EVENTS: string[] = Array.isArray(CFG?.refund_events) && CFG.refund_events.length > 0
  ? CFG.refund_events.map(String)
  : ["return.created"];
const LIVE_GATE = String(CFG?.live_gate ?? "data.live");
const SECRET_ENV = String(CFG?.secret_env ?? "FASTSPRING_WEBHOOK_SECRET");
const FM = (CFG?.field_map ?? {}) as Record<string, string | undefined>;

function safeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function signatureValid(secret: string, headers: IncomingHttpHeaders, rawBody: Buffer): boolean {
  const provided = headers[SIG_HEADER];
  if (typeof provided !== "string" || !provided) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let got: Buffer;
  try {
    got = Buffer.from(provided.trim(), "base64");
  } catch {
    return false;
  }
  return safeEqualBytes(expected, got);
}

function isoTs(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
    if (typeof v === "string" && v !== "" && !Number.isNaN(Date.parse(v))) return v;
  }
  return new Date().toISOString();
}

export const fastspringProvider: CheckoutProvider = {
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
    const events: any[] = Array.isArray(body?.events) ? body.events : [];
    if (events.length === 0) {
      return { ok: false, status: 400, error: "missing events[] array (JSON webhook mode)" };
    }

    const actions: ({ sale: SaleEvent } | { refund: RefundEvent })[] = [];
    const ignored: string[] = [];
    for (const evt of events) {
      const eventName = typeof evt?.type === "string" ? evt.type : "<none>";
      const data = evt?.data ?? {};
      // field_map / live_gate paths are EVENT-ENVELOPE-relative ("data.id", "data.live") —
      // resolve against evt, with the raw data object as the fallback source.
      const liveFlag = getPath(evt, LIVE_GATE) ?? data?.live ?? evt?.live;

      if (REFUND_EVENTS.includes(eventName)) {
        if (liveFlag === false) {
          return { ok: false, status: 202, error: `test event (${eventName}, live=false) — not recorded (production secret must never record test orders)` };
        }
        const saleId = String(getPath(evt, FM.refund_sale_id) ?? data?.original?.order ?? data?.original?.id ?? "");
        if (!saleId) {
          return { ok: false, status: 400, error: "return.created missing data.original.order — refund cannot be linked to a recorded sale" };
        }
        const totalReturn = Number(getPath(evt, FM.refund_total) ?? data?.totalReturn);
        const originalTotal = Number(getPath(evt, FM.refund_original_total) ?? data?.original?.total);
        if (Number.isFinite(totalReturn) && Number.isFinite(originalTotal) && totalReturn + 0.005 < originalTotal) {
          return { ok: false, status: 422, error: `partial return (${totalReturn} of ${originalTotal}) — ledger refund records are full reversals; partial refunds must be recorded manually` };
        }
        actions.push({
          refund: { provider: NAME, sale_id: saleId, ts: isoTs(evt?.created, getPath(evt, FM.refund_ts_ms), data?.changed) },
        });
        continue;
      }

      if (!SALE_EVENTS.includes(eventName)) {
        ignored.push(eventName);
        continue;
      }
      if (liveFlag === false) {
        return { ok: false, status: 202, error: `test event (${eventName}, live=false) — not recorded (production secret must never record test orders)` };
      }

      const items: any[] = Array.isArray(data?.items) ? data.items : [];
      const productId = getPath(evt, FM.product_id) ?? items[0]?.product;
      const total = Number(getPath(evt, FM.total) ?? data?.total);
      const currency = String(getPath(evt, FM.currency) ?? data?.currency ?? "").toUpperCase();
      const saleId = String(getPath(evt, FM.sale_id) ?? data?.id ?? "");
      const ts = isoTs(evt?.created, getPath(evt, FM.ts_ms), data?.changed);
      const email = getPath(evt, FM.email) ?? data?.customer?.email;

      if (!productId) return { ok: false, status: 400, error: `order.completed missing data.items[].product (event ${evt?.id ?? "<none>"})` };
      if (!saleId) return { ok: false, status: 400, error: `order.completed missing data.id (event ${evt?.id ?? "<none>"})` };
      if (!Number.isFinite(total) || total < 0) return { ok: false, status: 400, error: `order.completed invalid data.total (event ${evt?.id ?? "<none>"})` };
      if (currency && !isAllowedCurrency(currency)) return { ok: false, status: 400, error: `unsupported currency: ${currency}` };
      if (typeof email !== "string" || !email.includes("@")) return { ok: false, status: 400, error: `order.completed missing data.customer.email (event ${evt?.id ?? "<none>"})` };

      actions.push({
        sale: {
          sale_id: saleId,
          provider: NAME,
          product_id: String(productId),
          amount_usd: Math.round(total * 100) / 100,
          ts,
          email_hash: hashEmail(email),
        },
      });
    }

    if (actions.length === 0) {
      return { ok: false, status: 202, error: `ignored non-sale events: ${ignored.join(", ") || "<none>"}` };
    }
    if (actions.length === 1) {
      const first = actions[0]!;
      return "sale" in first ? { ok: true, sale: first.sale } : { ok: true, refund: first.refund };
    }
    return { ok: true, batch: actions };
  },
};
