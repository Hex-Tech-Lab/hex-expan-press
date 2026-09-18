// cascade_signals.ts — read-only stats over the sales ledger (payments/src/ledger.ts), computed
// for the automated pricing-cascade trigger logic (per-product/per-creator refund rate, and a
// conversion-rate stub pending click-tracking — see data/intel/duane_multi_channel_shortlinks_2026-09-18.md
// for the missing click-attribution half). This module does NOT decide or execute price changes —
// it only answers "what happened," per the founder's directive to build the data pipeline
// separately from cascade trigger/swap logic.
import { loadSales, type SaleLine } from "./reports.ts";
import { GLOBAL } from "./settings_registry.ts";

const DEFAULT_SALES_FILE: string = GLOBAL.paths.sales_ledger;

export interface RefundRateWindow {
  product_id: string;
  window_start: string;
  window_end: string;
  sales: number; // count of event_type="sale" in the window
  refunds: number; // count of event_type="refund" in the window (refund ts, not original sale ts)
  refund_rate: number; // refunds / sales, 0 when sales=0 (NOT NaN — callers must not divide again)
}

/**
 * Refund rate for one product over a trailing window ending "now" (or an injected `asOf` for
 * testability). `sales` counts events with ts inside the window; `refunds` counts refund events
 * with ts inside the window (a refund can land in a later window than its original sale — this
 * is intentional: the cascade cares about recent refund VOLUME, not attributing refunds back to
 * the sale's own window).
 */
export function refundRateWindow(opts: {
  productId: string;
  windowDays: number;
  asOf?: Date;
  salesFile?: string;
}): RefundRateWindow {
  const { productId, windowDays, asOf = new Date(), salesFile = DEFAULT_SALES_FILE } = opts;
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new RangeError(`cascade_signals: windowDays must be a positive finite number (got ${windowDays})`);
  }
  const windowEnd = asOf;
  const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);

  const all: SaleLine[] = loadSales(salesFile).filter((s) => s.product_id === productId);
  let sales = 0;
  let refunds = 0;
  for (const s of all) {
    const t = new Date(s.ts).getTime();
    if (t < windowStart.getTime() || t > windowEnd.getTime()) continue;
    if (s.event_type === "refund") refunds += 1;
    else sales += 1;
  }
  return {
    product_id: productId,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    sales,
    refunds,
    refund_rate: sales > 0 ? refunds / sales : 0,
  };
}

/**
 * CONVERSION RATE — NOT YET COMPUTABLE from the sales ledger alone.
 *
 * The ledger only records completed Polar orders (webhook-driven). It has no visibility into
 * checkout starts, click-throughs, or reach — those live upstream (short-link clicks, landing
 * page visits) and are not wired into this pipeline yet. Per the founder's explicit instruction
 * (2026-09-18): do NOT ship a weaker "purchases per unit time" proxy in place of real
 * click-to-buy conversion — that conflates "priced wrong" with "nobody's clicking," which is
 * exactly the failure mode the founder flagged. This function intentionally throws rather than
 * silently returning a misleading number.
 *
 * Real conversion rate requires: (1) per-channel short-link click counts (dub.co integration,
 * being built separately — see [[creator-outreach-workflow]] follow-up), and (2) joining click
 * volume against Polar order volume by source/UTM within the same window. Wire that up before
 * calling this — do not stub it with a fake denominator.
 */
export function conversionRateWindow(): never {
  throw new Error(
    "cascade_signals: conversionRateWindow() is not implemented — real click-through data " +
      "(dub.co short-link clicks) is required and not yet wired in. See the module-level comment.",
  );
}
