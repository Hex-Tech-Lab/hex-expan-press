import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCascade, applyCascadeDrop, currentTierPriceUsd, CascadeConfig } from "../src/cascade.ts";
import { appendSale, SaleRecord } from "../src/ledger.ts";

describe("payments/src/cascade", () => {
  let tmpDir: string;
  let configPath: string;
  let salesFile: string;

  const initialConfig: CascadeConfig = {
    product_id: "test_product_v1",
    note: "Test cascade",
    tiers_usd: [39, 27, 19],
    current_tier_index: 0,
    floor_tier_index: 2,
    thresholds: {
      refund_rate_ceiling_pct: 10,
      conversion_rate_floor_pct: 2,
      min_sample_per_channel: 500,
      sampling_note: "Test sampling",
    },
    history: [
      {
        ts: "2026-09-18T00:00:00.000Z",
        tier_index: 0,
        price_usd: 39,
        reason: "Initial launch",
      },
    ],
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cascade-test-"));
    configPath = join(tmpDir, "cascade.json");
    salesFile = join(tmpDir, "sales.jsonl");
    writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), "utf8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads current tier price correctly", () => {
    expect(currentTierPriceUsd(configPath)).toBe(39);
  });

  it("triggers a drop when refund rate exceeds ceiling (>10%)", async () => {
    const asOf = new Date("2026-09-18T12:00:00Z");
    
    // 8 normal sales
    for (let i = 1; i <= 8; i++) {
      const sale: SaleRecord = {
        ts: "2026-09-18T10:00:00.000Z",
        sale_id: `sale_${i}`,
        provider: "polar",
        product_id: "test_product_v1",
        amount_usd: 39,
        creator_id: "test_creator",
        creator_split_pct: 50,
        creator_split_usd: 19.5,
        our_split_usd: 19.5,
        currency: "USD",
      };
      await appendSale(sale, salesFile);
    }

    // 2 refunded sales (20% refund rate > 10% ceiling)
    for (let i = 9; i <= 10; i++) {
      const refundRecord: SaleRecord = {
        ts: "2026-09-18T11:00:00.000Z",
        sale_id: `sale_${i}`,
        provider: "polar",
        product_id: "test_product_v1",
        amount_usd: -39,
        creator_id: "test_creator",
        creator_split_pct: 50,
        creator_split_usd: -19.5,
        our_split_usd: -19.5,
        currency: "USD",
        event_type: "refund",
      };
      // Write raw refund into salesFile
      const { appendFile } = await import("node:fs/promises");
      await appendFile(salesFile, JSON.stringify(refundRecord) + "\n", "utf8");
    }

    const decision = evaluateCascade({
      configPath,
      windowDays: 7,
      salesFile,
      asOf,
    });

    expect(decision.should_drop).toBe(true);
    expect(decision.current_tier_index).toBe(0);
    expect(decision.next_tier_index).toBe(1);

    const updated = applyCascadeDrop(configPath, decision, asOf);
    expect(updated.current_tier_index).toBe(1);
    expect(currentTierPriceUsd(configPath)).toBe(27);
  });

  it("holds at floor tier (tier 2 = $19) with no further automated drops", () => {
    const floorConfig = {
      ...initialConfig,
      current_tier_index: 2,
    };
    writeFileSync(configPath, JSON.stringify(floorConfig, null, 2), "utf8");

    const decision = evaluateCascade({
      configPath,
      windowDays: 7,
      salesFile,
    });

    expect(decision.should_drop).toBe(false);
    expect(decision.next_tier_index).toBeNull();
    expect(decision.reason).toContain("already at floor tier");
  });
});
