/**
 * Download access for one sale, decided from its ledger rows (public.orders).
 *
 *   active   no refund is outstanding (a refund the provider reversed, a won dispute, counts as no refund)
 *   revoked  a refund is outstanding (a refund with no later refund_reversal): the sale's download links stop working
 *
 * The ledger records no chargeback event. A Paddle chargeback arrives as an adjustment and is mapped to the same
 * refund_issued event as a refund (src/adapters/payments/paddle.adapter.ts), so a chargeback revokes like a refund.
 * There is no "paused" state, because the ledger cannot tell a chargeback from a refund.
 *
 * Unknown input throws (no sale row, unknown event_type). Callers treat a throw as an unknown state and fail closed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type SaleAccess = "active" | "revoked";

/** One ledger row for a sale. A missing event_type is a legacy sale row. */
export interface SaleAccessEvent {
  event_type?: string | null;
}

/** Decides access from a sale's ledger events, given oldest first. */
export function saleAccessState(events: readonly SaleAccessEvent[]): SaleAccess {
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
  return refundOutstanding ? "revoked" : "active";
}

/**
 * Reads one sale's ledger rows, oldest first, for saleAccessState. public.orders is unique on
 * (provider, sale_id, event_type), and download_events carries no provider. A sale_id recorded under two
 * providers therefore has no single state, and this throws.
 */
export async function readSaleAccessEvents(sb: SupabaseClient, saleId: string): Promise<SaleAccessEvent[]> {
  const { data, error } = await sb
    .from("orders")
    .select("provider, event_type, occurred_at")
    .eq("sale_id", saleId)
    .order("occurred_at", { ascending: true });
  if (error) throw new Error(`sale access: ledger read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ provider: string; event_type: string | null }>;
  if (new Set(rows.map((r) => r.provider)).size > 1) {
    throw new Error("sale access: sale_id recorded under more than one provider (state unknown)");
  }
  return rows.map((r) => ({ event_type: r.event_type }));
}
