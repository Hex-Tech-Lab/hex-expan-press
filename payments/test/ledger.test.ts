import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSale, findSale, findRefund, findSalesByAttribution, SaleRecord } from "../src/ledger.ts";

describe("payments/src/ledger", () => {
  let tmpDir: string;
  let salesFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ledger-test-"));
    salesFile = join(tmpDir, "sales.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseSale: SaleRecord = {
    ts: "2026-09-18T12:00:00.000Z",
    sale_id: "sale_001",
    provider: "polar",
    product_id: "duane_retirement_playbook_v1",
    amount_usd: 39,
    creator_id: "retirearly500k",
    creator_split_pct: 50,
    creator_split_usd: 19.5,
    our_split_usd: 19.5,
    currency: "USD",
    attribution_id: "yt_desc_test_123",
  };

  it("appends and finds a sale correctly", async () => {
    const recorded = await appendSale(baseSale, salesFile);
    expect(recorded.sale_id).toBe("sale_001");

    const found = findSale("polar", "sale_001", salesFile);
    expect(found).not.toBeNull();
    expect(found?.amount_usd).toBe(39);
    expect(found?.attribution_id).toBe("yt_desc_test_123");
  });

  it("filters sales by canonical attribution_id", async () => {
    await appendSale(baseSale, salesFile);
    await appendSale(
      {
        ...baseSale,
        sale_id: "sale_002",
        attribution_id: "ig_bio_test_456",
      },
      salesFile
    );

    const matchesYt = findSalesByAttribution("yt_desc_test_123", salesFile);
    expect(matchesYt).toHaveLength(1);
    expect(matchesYt[0]?.sale_id).toBe("sale_001");

    const matchesIg = findSalesByAttribution("ig_bio_test_456", salesFile);
    expect(matchesIg).toHaveLength(1);
    expect(matchesIg[0]?.sale_id).toBe("sale_002");

    const matchesNone = findSalesByAttribution("nonexistent_tag", salesFile);
    expect(matchesNone).toHaveLength(0);
  });

  it("guards refund idempotency using findRefund", async () => {
    expect(findRefund("polar", "sale_001", salesFile)).toBeNull();
  });
});
