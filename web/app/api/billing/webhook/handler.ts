import { NextRequest, NextResponse } from "next/server";
import { processBillingWebhookUseCase } from "../../../../../src/use_cases/billing/process_billing_webhook";
import { WebhookValidationError } from "../../../../../src/domain/webhook/webhook_errors";
import { GLOBAL } from "../../../../../payments/src/settings_registry";

/**
 * Best-effort audit trail for 503 retry responses (event WEBHOOK_503_RETRYING).
 * An insert failure must NEVER change the response — the 503 already tells the
 * provider to retry; losing an audit row is strictly better than corrupting the
 * retry contract. Uses the service-role key server-side only (audit_log has RLS
 * on with no client policies).
 */
async function record503Audit(details: { provider?: string; sale_id?: string; reason: string }, signal: AbortSignal): Promise<void> {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) return; // unconfigured Supabase: nothing durable to write
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key);
    const { error } = await supabase.from("audit_log").insert({ event: "WEBHOOK_503_RETRYING", details }).abortSignal(signal);
    if (error) console.error("[billing-webhook] 503 audit insert failed:", error.message);
  } catch (err) {
    console.error("[billing-webhook] 503 audit insert exception:", err);
  }
}

/** Run the 503 audit for at most payments.http_timeout_ms (the webhook's short internal-call
 *  budget), then abort the insert so a stalled Supabase can't pile up open requests. The race
 *  keeps the response bounded even if the abort doesn't settle promptly. */
async function auditBounded(details: { provider?: string; sale_id?: string; reason: string }): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(); }, GLOBAL.payments.http_timeout_ms);
  });
  try {
    await Promise.race([record503Audit(details, controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Webhooks are small JSON bodies (KBs) — cap buffering at 1 MiB (the Wave 4
// contract carried over from the shim era) so a flood of oversized POSTs
// cannot create memory pressure.
const MAX_BODY_BYTES = 1_048_576;

/** Streams the request body with the byte cap enforced mid-read. */
async function readBodyCapped(request: NextRequest): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Billing webhook (Wave 6, native route handler — replaces the shim-bridged
 * legacy handler). Signature-based provider routing with strict HMAC
 * verification (fail-closed, verified in Wave 5.1); raw body comes from
 * request.text() byte-exactly.
 */
export type WebhookAdapters = Parameters<typeof processBillingWebhookUseCase>[1];

/** Handler factory: production wires the real providers below; tests inject a signed fixture adapter. */
export function createWebhookHandler(buildAdapters: () => WebhookAdapters): (request: NextRequest) => Promise<NextResponse> {
  return (request) => handleWebhook(request, buildAdapters());
}

async function handleWebhook(request: NextRequest, adapters: WebhookAdapters): Promise<NextResponse> {
  const bodyBuffer = await readBodyCapped(request);
  if (bodyBuffer === null) {
    return NextResponse.json({ ok: false, error: "Payload Too Large" }, { status: 413 });
  }
  const body = bodyBuffer.toString("utf8");
  const headers = Object.fromEntries(request.headers);

  try {
    const outcome = await processBillingWebhookUseCase({ headers, body }, adapters);
    // Adjustment-id collision stored in the reconciliation inbox: 202 stops the provider's retry loop (any 2xx
    // is delivered) while the event waits for an operator in public.webhook_conflicts.
    if (outcome?.status === 202) {
      return NextResponse.json(outcome.payload, { status: 202 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Another delivery of this event holds the idempotency lock and has not
    // persisted yet — never 200 here (the holder may still fail). 503 +
    // Retry-After makes the provider redeliver.
    if (err instanceof Error && err.name === "WebhookInFlightError") {
      await auditBounded({ ...auditContext(headers, body), reason: "idempotency_lock_in_flight" });
      return NextResponse.json(
        { ok: false, error: "In flight — retry" },
        { status: 503, headers: retryAfterHeaders() },
      );
    }
    console.error("Billing webhook error:", err);
    const message = err instanceof Error ? err.message : String(err);
    // Typed classification first (sprint-10 F5); the substring checks are a
    // deprecated fallback kept one release for legacy error paths.
    const isValidationErr = err instanceof WebhookValidationError || message.includes("validation failed") || message.includes("No payment provider");
    // The use case attaches httpStatus to validation failures (e.g. 401 for a
    // bad/stale signature) — honor it when in the 4xx band; otherwise the
    // legacy 400/500 split stands.
    const rawStatus = err instanceof WebhookValidationError ? err.httpStatus : (err as { httpStatus?: unknown })?.httpStatus;
    // Honour the adapter's hint: 4xx is final; 5xx (missing secret = 500, email lookup failure = 503)
    // makes the provider RETRY — never flatten a server-side problem into a permanent 400.
    const httpStatus = typeof rawStatus === "number" && rawStatus >= 400 && rawStatus < 600 ? rawStatus : undefined;
    const status = isValidationErr && httpStatus === undefined ? 400 : httpStatus ?? (isValidationErr ? 400 : 500);
    const error = status === 401 ? "Unauthorized" : status === 503 ? "Temporarily unavailable — retry" : status === 500 ? "Internal Server Error" : "Bad Request";
    if (status === 503) {
      // Error name only: messages can carry buyer data (e.g. an email lookup failure).
      await auditBounded({ ...auditContext(headers, body), reason: err instanceof Error ? err.name : "unknown" });
    }
    return NextResponse.json({ ok: false, error }, { status, headers: status === 503 ? retryAfterHeaders() : undefined });
  }
}

/** Every 503 tells the provider when to redeliver (value from the settings registry). */
function retryAfterHeaders(): Record<string, string> {
  return { "Retry-After": String(GLOBAL.payments.retry_after_seconds) };
}

/** Best-effort provider/sale for audit context — parsed defensively; a
 *  malformed body must never break the 503 response itself. */
function auditContext(headers: Record<string, string | string[] | undefined>, body: string): { provider?: string; sale_id?: string } {
  const provider =
    headers["paddle-signature"] !== undefined ? "paddle"
    : headers["webhook-signature"] !== undefined ? "polar"
    : headers["x-fngs-signature"] !== undefined ? "fungies"
    : undefined;
  try {
    const parsed = JSON.parse(body) as { data?: { id?: unknown; transaction_id?: unknown } };
    const saleId = typeof parsed?.data?.transaction_id === "string" ? parsed.data.transaction_id : typeof parsed?.data?.id === "string" ? parsed.data.id : undefined;
    return { provider, sale_id: saleId?.slice(0, 128) };
  } catch {
    return { provider };
  }
}
