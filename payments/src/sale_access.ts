/**
 * Download access for one sale, decided from its ledger rows (public.orders).
 *
 *   active   no refund is outstanding (a refund the provider reversed, a won dispute, counts as no refund)
 *   revoked  a refund is outstanding (a refund with no later refund_reversal): the sale's download links stop working
 *
 * The ledger records no chargeback event. A Paddle chargeback arrives as an adjustment and is mapped to the same
 * refund_issued event as a refund (src/adapters/payments/paddle.adapter.ts), so a chargeback revokes like a refund.
 * A "paused" state is planned for when the ledger records disputes as their own event. Until then the state set
 * stays {active, revoked}, and the route denies every state other than "active", so adding one fails closed.
 *
 * Unknown input throws (no sale row, unknown event_type). Callers treat a throw as an unknown state and fail closed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type SaleAccess = "active" | "revoked";

/** One ledger row for a sale. A missing event_type is a legacy sale row. */
export interface SaleAccessEvent {
  event_type?: string | null;
}

/**
 * Decides access from a sale's ledger events, given oldest first. An open manual-review flag (see
 * readOpenReviewFlag) revokes the sale whatever the ledger shows: a flagged refund is not in the ledger, so
 * the ledger alone would still read active.
 */
export function saleAccessState(events: readonly SaleAccessEvent[], options: { reviewOpen?: boolean } = {}): SaleAccess {
  let sawSale = false;
  let refundOutstanding = false;
  for (const ev of events) {
    const type = ev.event_type ?? "sale";
    if (type === "sale") sawSale = true;
    else if (type === "refund") refundOutstanding = true;
    else if (type === "refund_reversal") refundOutstanding = false;
    else throw new TypeError(`sale access: unknown event_type "${String(type)}"`);
  }
  if (!sawSale) throw new TypeError("sale access: no sale row recorded (state unknown)");
  return refundOutstanding || options.reviewOpen === true ? "revoked" : "active";
}

/**
 * True when a refund arriving after a reversal is flagged for manual review and not yet reviewed. The webhook
 * answers such a refund 200 and writes the flag (audit_log MANUAL_REVIEW_REQUIRED_REFUND, reason
 * refund_after_reversal) before it does: a provider stops retrying on any 2xx, so the audit row is the only
 * durable record. The flag is keyed by sale_id alone, so a match can only deny more, never serve more.
 */
export async function readOpenReviewFlag(sb: SupabaseClient, saleId: string): Promise<boolean> {
  const { data, error } = await sb
    .from("audit_log")
    .select("id")
    .eq("event", "MANUAL_REVIEW_REQUIRED_REFUND")
    .eq("details->>sale_id", saleId)
    .eq("details->>reason", "refund_after_reversal")
    .limit(1);
  if (error) throw new Error(`sale access: review flag read failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Causal rank of a ledger event. A refund follows its sale and a reversal follows its refund. */
const CAUSAL_RANK: Record<string, number> = { sale: 0, refund: 1, refund_reversal: 2 };

/**
 * Reads one sale's ledger rows, in insertion order, for saleAccessState. Order is the row's created_at (the
 * insertion time; orders.id is a uuid, so it carries no sequence). The provider's occurred_at is not used: a
 * reversal can be stamped before its refund, and the ledger refuses a reversal without a prior refund at write
 * time, so insertion order is the causal order. Rows with an identical created_at fall back to causal rank.
 * public.orders is unique on (provider, sale_id, event_type), and download_events carries no provider. A sale_id
 * recorded under two providers therefore has no single state, and this throws.
 */
export async function readSaleAccessEvents(sb: SupabaseClient, saleId: string): Promise<SaleAccessEvent[]> {
  const { data, error } = await sb
    .from("orders")
    .select("provider, event_type, created_at")
    .eq("sale_id", saleId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`sale access: ledger read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ provider: string; event_type: string | null; created_at: string }>;
  if (new Set(rows.map((r) => r.provider)).size > 1) {
    throw new Error("sale access: sale_id recorded under more than one provider (state unknown)");
  }
  const rank = (r: { event_type: string | null }) => CAUSAL_RANK[r.event_type ?? "sale"] ?? Number.MAX_SAFE_INTEGER;
  const ordered: typeof rows = [];
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && rows[j].created_at === rows[i].created_at) j++;
    ordered.push(...rows.slice(i, j).sort((a, b) => rank(a) - rank(b)));
    i = j;
  }
  return ordered.map((r) => ({ event_type: r.event_type }));
}
