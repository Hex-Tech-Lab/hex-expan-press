// stuck_report.ts: read-only operator check for buyers the webhook cannot resend on its own.
//   1. delivery_sends rows still in state 'claimed' older than delivery.stuck_claim_after_seconds. The next provider retry
//      resends a row with a stored message, under the same key and within delivery.stored_message_resend_max_age_hours. A
//      legacy row (created before delivery.stored_message_since) with no stored message is flagged and never resent.
//   2. audit_log MANUAL_REVIEW_REQUIRED_REFUND rows, deduplicated per (provider, sale_id) like listManualReviewRefunds.
//   3. audit_log WEBHOOK_TERMINAL_REJECT rows within delivery.terminal_reject_lookback_hours, newest first, capped at
//      delivery.terminal_reject_list_limit. A buyer whose address the mail provider refused (DeliveryBlockedError, 422) is
//      booked and quarantined by the webhook handler (web/app/api/billing/webhook/handler.ts), and its only console flag is
//      payments/src/delivery.ts flagForManualReconciliation. This listing is the operator path to find those sales. The row
//      records the error name as reason, not the block reason, and there is no acknowledge step: a row stays listed until
//      it ages out of the window.
// Reads the live database through PostgREST with SUPABASE_URL and SUPABASE_SECRET_KEY. Names only: values are never printed.
// Thresholds and limits come from payments/src/settings_registry.ts.
//
// Exit codes: 0 = nothing stuck, nothing in the review queue, and no terminal reject in the window;
//             1 = at least one stuck claim, manual-review refund, or terminal reject (count > 0);
//             2 = config missing, non-HTTPS URL, or a read failed, so the check could not decide.
//
// Usage: node --import tsx scripts/ops/stuck_report.ts

import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { GLOBAL } from "../../payments/src/settings_registry.ts";

export type Env = Record<string, string | undefined>;
export type HttpFetch = typeof fetch;

export interface StuckSettings {
  stuck_claim_after_seconds: number;
  stuck_claim_list_limit: number;
  review_queue_page_size: number;
  terminal_reject_lookback_hours: number;
  terminal_reject_list_limit: number;
  timeout_ms: number;
}

export interface StuckClaim {
  provider: string;
  saleId: string;
  sendKind: string;
  claimedAt: string;
}

export interface ReviewItem {
  provider: string | null;
  saleId: string | null;
  occurrences: number;
}

export interface TerminalReject {
  provider: string | null;
  saleId: string | null;
  reason: string | null;
  at: string;
}

export interface StuckReport {
  stuckClaims: StuckClaim[];
  claimLimit: number;
  reviewItems: ReviewItem[];
  reviewRowsRead: number;
  reviewLimit: number;
  terminalRejects: TerminalReject[];
  terminalRejectLimit: number;
  terminalRejectLookbackHours: number;
}

export class StuckCheckError extends Error {}

export function settingsFromGlobal(): StuckSettings {
  return {
    stuck_claim_after_seconds: GLOBAL.delivery.stuck_claim_after_seconds,
    stuck_claim_list_limit: GLOBAL.delivery.stuck_claim_list_limit,
    review_queue_page_size: GLOBAL.payments.review_queue_page_size,
    terminal_reject_lookback_hours: GLOBAL.delivery.terminal_reject_lookback_hours,
    terminal_reject_list_limit: GLOBAL.delivery.terminal_reject_list_limit,
    timeout_ms: GLOBAL.payments.sync_http_timeout_ms,
  };
}

/** Exit 1 when any count is above zero; the caller maps thrown errors to exit 2. */
export function exitCodeForStuck(report: StuckReport): 0 | 1 {
  return report.stuckClaims.length > 0 || report.reviewItems.length > 0 || report.terminalRejects.length > 0 ? 1 : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Same dedupe as payments/src/ledger.ts listManualReviewRefunds: one entry per (provider, sale_id); incomplete rows stay standalone. */
export function dedupeReviewRows(rows: Array<{ details: unknown }>): ReviewItem[] {
  const byPair = new Map<string, ReviewItem>();
  const standalone: ReviewItem[] = [];
  for (const row of rows) {
    const details = typeof row.details === "object" && row.details !== null ? (row.details as Record<string, unknown>) : {};
    const provider = str(details.provider);
    const saleId = str(details.sale_id);
    if (provider === null || saleId === null) {
      standalone.push({ provider, saleId, occurrences: 1 });
      continue;
    }
    const key = `${provider}|${saleId}`;
    const hit = byPair.get(key);
    if (hit) hit.occurrences += 1;
    else byPair.set(key, { provider, saleId, occurrences: 1 });
  }
  return [...byPair.values(), ...standalone];
}

/** One WEBHOOK_TERMINAL_REJECT row. details.provider and details.sale_id are absent when the headers or body did not parse. */
export function terminalRejectFrom(row: Record<string, unknown>): TerminalReject {
  const details = typeof row.details === "object" && row.details !== null ? (row.details as Record<string, unknown>) : {};
  return {
    provider: str(details.provider),
    saleId: str(details.sale_id),
    reason: str(details.reason),
    at: String(row.created_at),
  };
}

function requireHttpsBase(env: Env): { base: string; key: string } {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new StuckCheckError("SUPABASE_URL or SUPABASE_SECRET_KEY is not set; cannot read the live database");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new StuckCheckError("SUPABASE_URL is not a valid URL");
  }
  // The secret key travels in the Authorization header, so it never goes over plain HTTP.
  if (parsed.protocol !== "https:") throw new StuckCheckError("SUPABASE_URL must be HTTPS");
  return { base: url.replace(/\/+$/, ""), key };
}

async function getRows(http: HttpFetch, url: string, key: string, timeoutMs: number, what: string): Promise<Array<Record<string, unknown>>> {
  const res = await http(url, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Only the status is reported: a response body could echo request data.
  if (!res.ok) throw new StuckCheckError(`${what} failed: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
}

/** Read-only collection. Every request is a GET; no row is written. */
export async function collectStuck(env: Env, http: HttpFetch, nowMs: number, settings: StuckSettings): Promise<StuckReport> {
  const { base, key } = requireHttpsBase(env);
  const cutoff = new Date(nowMs - settings.stuck_claim_after_seconds * 1000).toISOString();

  const claimRows = await getRows(
    http,
    `${base}/rest/v1/delivery_sends?select=provider,sale_id,send_kind,created_at&state=eq.claimed&created_at=lte.${encodeURIComponent(cutoff)}&order=created_at.asc&limit=${settings.stuck_claim_list_limit}`,
    key,
    settings.timeout_ms,
    "stuck delivery claim lookup",
  );
  const stuckClaims: StuckClaim[] = claimRows.map((row) => ({
    provider: String(row.provider),
    saleId: String(row.sale_id),
    sendKind: String(row.send_kind),
    claimedAt: String(row.created_at),
  }));

  const reviewRows = await getRows(
    http,
    `${base}/rest/v1/audit_log?select=id,created_at:at,event,details&event=eq.MANUAL_REVIEW_REQUIRED_REFUND&order=at.desc,id.desc&limit=${settings.review_queue_page_size}`,
    key,
    settings.timeout_ms,
    "manual-review queue read",
  );

  const rejectSince = new Date(nowMs - settings.terminal_reject_lookback_hours * 3600 * 1000).toISOString();
  const rejectRows = await getRows(
    http,
    `${base}/rest/v1/audit_log?select=id,created_at:at,event,details&event=eq.WEBHOOK_TERMINAL_REJECT&at=gte.${encodeURIComponent(rejectSince)}&order=at.desc,id.desc&limit=${settings.terminal_reject_list_limit}`,
    key,
    settings.timeout_ms,
    "terminal reject read",
  );

  return {
    stuckClaims,
    claimLimit: settings.stuck_claim_list_limit,
    reviewItems: dedupeReviewRows(reviewRows as Array<{ details: unknown }>),
    reviewRowsRead: reviewRows.length,
    reviewLimit: settings.review_queue_page_size,
    terminalRejects: rejectRows.map(terminalRejectFrom),
    terminalRejectLimit: settings.terminal_reject_list_limit,
    terminalRejectLookbackHours: settings.terminal_reject_lookback_hours,
  };
}

export function renderStuck(report: StuckReport, afterSeconds: number): string {
  const lines: string[] = [];
  const capClaims = report.stuckClaims.length >= report.claimLimit;
  lines.push(`Stuck delivery claims (state=claimed, older than ${afterSeconds} s): ${capClaims ? "at least " : ""}${report.stuckClaims.length}`);
  for (const c of report.stuckClaims.slice(0, 20)) lines.push(`  ${c.provider}  sale ${c.saleId}  ${c.sendKind}  claimed ${c.claimedAt}`);
  const capReview = report.reviewRowsRead >= report.reviewLimit;
  lines.push(`Manual-review refunds (MANUAL_REVIEW_REQUIRED_REFUND, distinct sale): ${capReview ? "at least " : ""}${report.reviewItems.length}`);
  for (const i of report.reviewItems.slice(0, 20)) lines.push(`  ${i.provider ?? "(no provider)"}  sale ${i.saleId ?? "(no sale_id)"}  rows ${i.occurrences}`);
  // Printed only when there is at least one reject, so an empty window adds no lines.
  if (report.terminalRejects.length > 0) {
    const capRejects = report.terminalRejects.length >= report.terminalRejectLimit;
    lines.push(
      `Terminal webhook rejects (WEBHOOK_TERMINAL_REJECT, last ${report.terminalRejectLookbackHours} h, newest first): ${capRejects ? "at least " : ""}${report.terminalRejects.length}`,
    );
    for (const r of report.terminalRejects.slice(0, 20)) {
      lines.push(`  ${r.provider ?? "(no provider)"}  sale ${r.saleId ?? "(no sale_id)"}  reason ${r.reason ?? "(no reason)"}  at ${r.at}`);
    }
    if (report.terminalRejects.length > 20) lines.push(`  ... ${report.terminalRejects.length - 20} more not shown`);
  }
  lines.push("");
  lines.push(exitCodeForStuck(report) === 0 ? "RESULT: clear (exit 0)" : "RESULT: action needed, verify each buyer by hand (exit 1)");
  return `${lines.join("\n")}\n`;
}

const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  dotenv.config({ quiet: true });
  const settings = settingsFromGlobal();
  collectStuck(process.env, fetch, Date.now(), settings)
    .then((report) => {
      process.stdout.write(renderStuck(report, settings.stuck_claim_after_seconds));
      process.exitCode = exitCodeForStuck(report);
    })
    .catch((err: unknown) => {
      process.stderr.write(`stuck_report could not decide: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    });
}
