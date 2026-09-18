// cascade.ts — reads pricing-cascade config + live signals (payments/src/cascade_signals.ts) and
// decides / applies automated tier drops. Founder directive 2026-09-18: prices are variables that
// live in settings, never hardcoded; the cascade itself must actually execute, not just be
// designed. This module owns the decision AND the write-back — cascade_signals.ts stays read-only.
import { readFileSync, writeFileSync } from "node:fs";
import { refundRateWindow } from "./cascade_signals.ts";

export interface CascadeConfig {
  product_id: string;
  note: string;
  tiers_usd: number[];
  current_tier_index: number;
  floor_tier_index: number;
  thresholds: {
    refund_rate_ceiling_pct: number;
    conversion_rate_floor_pct: number;
    min_sample_per_channel: number;
    sampling_note: string;
  };
  history: Array<{ ts: string; tier_index: number; price_usd: number; reason: string }>;
}

export interface CascadeDecision {
  should_drop: boolean;
  reason: string;
  current_tier_index: number;
  next_tier_index: number | null; // null when already at floor or no drop triggered
  refund_rate_pct: number;
  refund_sample: number;
  conversion_evaluated: boolean; // false until real click data exists — see cascade_signals.ts
}

export function loadCascadeConfig(configPath: string): CascadeConfig {
  const raw = readFileSync(configPath, "utf8");
  return JSON.parse(raw) as CascadeConfig;
}

function writeCascadeConfig(configPath: string, cfg: CascadeConfig): void {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/**
 * Evaluate whether the current tier should drop, using only signals that are actually
 * computable today (refund rate). Conversion-rate evaluation is skipped, not faked — see
 * cascade_signals.ts's conversionRateWindow() for why. This means the cascade currently only
 * reacts to the refund-rate tripwire; the conversion tripwire activates automatically once
 * real click-through data exists, with no code change needed here beyond wiring that source in.
 */
export function evaluateCascade(opts: {
  configPath: string;
  windowDays: number;
  salesFile?: string;
  asOf?: Date;
}): CascadeDecision {
  const cfg = loadCascadeConfig(opts.configPath);
  const refund = refundRateWindow({
    productId: cfg.product_id,
    windowDays: opts.windowDays,
    asOf: opts.asOf,
    salesFile: opts.salesFile,
  });
  const refundRatePct = refund.refund_rate * 100;

  const atFloor = cfg.current_tier_index >= cfg.floor_tier_index;
  const refundTripped = refundRatePct > cfg.thresholds.refund_rate_ceiling_pct;

  if (atFloor) {
    return {
      should_drop: false,
      reason: "already at floor tier — no further automated drops",
      current_tier_index: cfg.current_tier_index,
      next_tier_index: null,
      refund_rate_pct: refundRatePct,
      refund_sample: refund.sales,
      conversion_evaluated: false,
    };
  }

  if (refundTripped) {
    return {
      should_drop: true,
      reason: `refund rate ${refundRatePct.toFixed(1)}% exceeds ceiling ${cfg.thresholds.refund_rate_ceiling_pct}% over trailing window (${refund.sales} sales, ${refund.refunds} refunds)`,
      current_tier_index: cfg.current_tier_index,
      next_tier_index: cfg.current_tier_index + 1,
      refund_rate_pct: refundRatePct,
      refund_sample: refund.sales,
      conversion_evaluated: false,
    };
  }

  return {
    should_drop: false,
    reason: "no tripwire fired (refund rate within ceiling; conversion tripwire not yet evaluable — no click-through data wired in)",
    current_tier_index: cfg.current_tier_index,
    next_tier_index: null,
    refund_rate_pct: refundRatePct,
    refund_sample: refund.sales,
    conversion_evaluated: false,
  };
}

/**
 * Apply a triggered drop: advances current_tier_index, appends a history entry, and writes the
 * config back. Does NOT touch payments/config.duane.json directly — call syncPriceToProductConfig
 * (or re-run the bake pipeline) after this so the live product page picks up the new price.
 */
export function applyCascadeDrop(configPath: string, decision: CascadeDecision, asOf: Date = new Date()): CascadeConfig {
  if (!decision.should_drop || decision.next_tier_index === null) {
    throw new Error("cascade: applyCascadeDrop called with a decision that does not authorize a drop");
  }
  const cfg = loadCascadeConfig(configPath);
  if (decision.next_tier_index !== cfg.current_tier_index + 1) {
    throw new Error("cascade: decision.next_tier_index is stale relative to the config on disk — re-evaluate before applying");
  }
  cfg.current_tier_index = decision.next_tier_index;
  cfg.history.push({
    ts: asOf.toISOString(),
    tier_index: cfg.current_tier_index,
    price_usd: cfg.tiers_usd[cfg.current_tier_index]!,
    reason: decision.reason,
  });
  writeCascadeConfig(configPath, cfg);
  return cfg;
}

/** Reads the current tier's live price straight from the cascade config — the one place a caller
 *  (e.g. the bake pipeline) should get "the price" from. Never read a hardcoded price_usd. */
export function currentTierPriceUsd(configPath: string): number {
  const cfg = loadCascadeConfig(configPath);
  return cfg.tiers_usd[cfg.current_tier_index]!;
}
