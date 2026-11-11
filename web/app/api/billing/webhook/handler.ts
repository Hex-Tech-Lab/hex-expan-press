import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { processBillingWebhookUseCase } from "../../../../../src/use_cases/billing/process_billing_webhook";
import { WebhookValidationError } from "../../../../../src/domain/webhook/webhook_errors";
import { OrderSchemaError } from "../../../../../payments/src/ledger";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import { createServiceClient } from "../../../../../payments/src/supabase_admin";

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
    if (!url || !key) {
      // Unconfigured Supabase: nothing durable to write. Logged so the missing row is visible to operators.
      console.error(`[billing-webhook] audit skipped: SUPABASE_URL or SUPABASE_SECRET_KEY unset (event=WEBHOOK_503_RETRYING reason=${details.reason})`);
      return;
    }
    const supabase = await createServiceClient(url, key);
    const { error } = await supabase.from("audit_log").insert({ event: "WEBHOOK_503_RETRYING", details }).abortSignal(signal);
    if (error) console.error("[billing-webhook] 503 audit insert failed:", error.message);
  } catch (err) {
    console.error("[billing-webhook] 503 audit insert exception:", err);
  }
}

/** Run the 503 audit for at most payments.http_timeout_ms (the webhook's short internal-call
 *  budget), then abort the insert so a stalled Supabase can't pile up open requests. The race
 *  keeps the response bounded even if the abort doesn't settle promptly. */
export async function auditBounded(
  details: { provider?: string; sale_id?: string; reason: string },
  run: typeof record503Audit = record503Audit,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(); }, GLOBAL.payments.http_timeout_ms);
  });
  // .finally, not try/finally: eslint-plugin-security-node crashes on a TryStatement with no catch.
  // The async wrapper turns a synchronous throw from run into a rejection, so .finally still clears the timer.
  await Promise.race([(async () => run(details, controller.signal))(), timeout]).finally(() => clearTimeout(timer));
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
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Billing webhook (Wave 6, native route handler — replaces the shim-bridged
 * legacy handler). Signature-based provider routing with strict HMAC
 * verification (fail-closed, verified in Wave 5.1); raw body comes from
 * request.text() byte-exactly.
 */
export type WebhookAdapters = Parameters<typeof processBillingWebhookUseCase>[1];

/** Audit events written for a terminal 4xx: a rejected payload, or a verified delivery for a switched-off rail. */
type TerminalAuditEvent = "WEBHOOK_TERMINAL_REJECT" | "WEBHOOK_PROVIDER_SWITCHED_OFF";

/** Handler factory: production wires the real providers below; tests inject a signed fixture adapter.
 *  `buildSwitchedOffAdapters` are the verifiers of switched-off rails: they only recognise a signed delivery
 *  for a switched-off rail so it can be recorded for manual review. */
export function createWebhookHandler(
  buildAdapters: () => WebhookAdapters,
  buildSwitchedOffAdapters: () => WebhookAdapters = () => [],
): (request: NextRequest) => Promise<NextResponse> {
  return (request) => handleWebhook(request, buildAdapters(), buildSwitchedOffAdapters());
}

async function handleWebhook(request: NextRequest, adapters: WebhookAdapters, switchedOffAdapters: WebhookAdapters): Promise<NextResponse> {
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
    // No switched-on rail claimed this signature. If a switched-off rail does, the delivery is a real sale for a
    // rail we are not taking: record it for manual review rather than let it vanish. Unclaimed traffic falls
    // through to the generic 400 below and writes no row.
    if (err instanceof WebhookValidationError && (err as { senderVerified?: boolean }).senderVerified === false) {
      const offRail = switchedOffAdapters.find((a) => a.canHandleWebhook(headers, body));
      if (offRail) return refuseSwitchedOffDelivery(offRail, headers, body, bodyBuffer);
    }
    console.error("Billing webhook error:", err);
    // Ledger schema violations are permanent for the payload (e.g. sub-cent amounts):
    // a 500 would make Paddle/Polar retry forever. Terminal 400 halts the retry loop;
    // the raw event is quarantined durably (sha256 + provider + sale id — the raw body
    // itself is NOT stored: webhook bodies carry buyer PII and audit_log must not).
    if (err instanceof OrderSchemaError) {
      await quarantineTerminalEvent(headers, bodyBuffer, err.name);
      return NextResponse.json({ ok: false, error: "Bad Request" }, { status: 400 });
    }
    // Typed classification only. Message text is never inspected: a transient failure can mention
    // "validation failed" and must stay retryable (500), not become a terminal 400.
    const isValidationErr = err instanceof WebhookValidationError;
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
    // Post-authentication terminal 4xx (validation 400s, semantic 422s —
    // everything except a 401 unauthenticated reject) is final for this
    // payload: quarantine it so it lives somewhere besides the provider's
    // redelivery queue. NEVER quarantine unverified senders: a 401, or any
    // error marked senderVerified=false (e.g. no provider claimed the
    // signature headers) — unauthenticated traffic must not force service-role
    // audit_log inserts per request (external review PR #78). 503s are already
    // audited via auditBounded above.
    if (status < 500 && status !== 401 && (err as { senderVerified?: boolean }).senderVerified !== false) {
      await quarantineTerminalEvent(headers, bodyBuffer, err instanceof Error ? err.name : "unknown");
    }
    return NextResponse.json({ ok: false, error }, { status, headers: status === 503 ? retryAfterHeaders() : undefined });
  }
}

/** A signed delivery for a switched-off rail. The rail's own verifier must verify it first. A verified delivery is
 *  recorded (WEBHOOK_PROVIDER_SWITCHED_OFF, shown in the admin queue) and then answered with a terminal 400, so the
 *  provider stops retrying a rail we are not taking. If that record cannot be written, the delivery is the only
 *  trace of a real sale, so the answer is a 503 with Retry-After and the provider redelivers. An unverified
 *  delivery gets a 400 and writes no row. A verifier that throws is logged and answered 503 (retry), never a 400. */
async function refuseSwitchedOffDelivery(
  rail: WebhookAdapters[number],
  headers: Record<string, string | string[] | undefined>,
  body: string,
  bodyBuffer: Buffer,
): Promise<NextResponse> {
  const unavailable = () => NextResponse.json({ ok: false, error: "Temporarily unavailable — retry" }, { status: 503, headers: retryAfterHeaders() });
  // The verifier's status decides the answer. 401 (bad signature or stale timestamp) and anything unclassified are
  // unverified: a 400 and no row. A 5xx is a server-side fault (missing secret, internal error): retry, never a
  // terminal 400. A 400 is signed but malformed: it is recorded like any verified delivery, then refused.
  const outcome = await rail.parseAndValidateWebhook(headers, body).then(
    (r) => ({ ok: true as const, r }),
    (err: unknown) => {
      console.error(`[billing-webhook] switched-off verifier ${rail.providerName} threw:`, err);
      return { ok: false as const };
    },
  );
  if (!outcome.ok) return unavailable();
  const result = outcome.r;
  if (!result.isValid) {
    if (result.httpStatus !== undefined && result.httpStatus >= 500) {
      console.error(`[billing-webhook] switched-off rail ${rail.providerName} verifier server fault (httpStatus=${result.httpStatus}) — retrying, nothing recorded`);
      return unavailable();
    }
    if (result.httpStatus !== 400) return NextResponse.json({ ok: false, error: "Bad Request" }, { status: 400 });
  }
  const payloadSha256 = createHash("sha256").update(bodyBuffer).digest("hex");
  const recorded = await auditTerminalBounded(headers, bodyBuffer, "provider_switched_off", "WEBHOOK_PROVIDER_SWITCHED_OFF", `WEBHOOK_PROVIDER_SWITCHED_OFF:${rail.providerName}:${payloadSha256}`);
  if (!recorded) return unavailable();
  return NextResponse.json({ ok: false, error: "Bad Request" }, { status: 400 });
}

/** Terminal-reject quarantine: the provider stops retrying on this response, so the
 *  rejected event must live somewhere besides the provider's redelivery queue. Durable
 *  audit row keyed by the payload sha256 of the RAW BYTES (NOT the body itself — buyer
 *  PII; and not the decoded string — distinct invalid-UTF-8 payloads must not collapse
 *  to one digest). Best-effort: a quarantine write failure must never change the
 *  already-computed response. */
async function quarantineTerminalEvent(
  headers: Record<string, string | string[] | undefined>,
  bodyBuffer: Buffer,
  reason: string,
): Promise<void> {
  // Bounded write; the quarantine outcome is not reported to the provider.
  await auditTerminalBounded(headers, bodyBuffer, reason, "WEBHOOK_TERMINAL_REJECT");
}

/** Same bounded write as the quarantine, but reports whether the audit row was actually written. A switched-off
 *  delivery whose row is not written is the only durable trace of a real sale, so the caller must not tell the
 *  provider to stop retrying. A timeout or a write failure returns false. */
async function auditTerminalBounded(
  headers: Record<string, string | string[] | undefined>,
  bodyBuffer: Buffer,
  reason: string,
  event: TerminalAuditEvent,
  idempotencyKey?: string,
): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(false); }, GLOBAL.payments.http_timeout_ms);
  });
  return await Promise.race([writeTerminalAudit(headers, bodyBuffer, reason, controller.signal, event, idempotencyKey), timeout]).finally(() => clearTimeout(timer));
}

/** Writes one terminal audit row. Resolves true only when the row was written. Never throws. */
async function writeTerminalAudit(
  headers: Record<string, string | string[] | undefined>,
  bodyBuffer: Buffer,
  reason: string,
  signal: AbortSignal,
  event: TerminalAuditEvent,
  idempotencyKey?: string,
): Promise<boolean> {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) {
      console.error(`[billing-webhook] audit skipped: SUPABASE_URL or SUPABASE_SECRET_KEY unset (event=${event} reason=${reason})`);
      return false;
    }
    const supabase = await createServiceClient(url, key);
    const row = {
      event,
      details: { ...auditContext(headers, bodyBuffer.toString("utf8")), reason, payload_sha256: createHash("sha256").update(bodyBuffer).digest("hex") },
    };
    // A keyed row is written with ON CONFLICT DO NOTHING (same pattern as the manual-review refund flag), so a retry
    // after a timeout that still committed does not duplicate the record. The audit row is append-only: no UPDATE.
    const { error } = idempotencyKey
      ? await supabase.from("audit_log").upsert({ ...row, idempotency_key: idempotencyKey }, { onConflict: "idempotency_key", ignoreDuplicates: true }).abortSignal(signal)
      : await supabase.from("audit_log").insert(row).abortSignal(signal);
    if (error) {
      console.error(`[billing-webhook] ${event} audit insert failed:`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[billing-webhook] ${event} audit exception:`, err);
    return false;
  }
}

/** Best-effort terminal-reject audit. Never throws, and its outcome is not reported to the provider. */
export async function insertTerminalRejectAudit(
  headers: Record<string, string | string[] | undefined>,
  bodyBuffer: Buffer,
  reason: string,
  signal: AbortSignal,
  event: TerminalAuditEvent = "WEBHOOK_TERMINAL_REJECT",
): Promise<void> {
  await writeTerminalAudit(headers, bodyBuffer, reason, signal, event);
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
