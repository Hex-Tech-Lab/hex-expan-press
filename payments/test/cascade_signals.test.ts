import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refundRateWindow } from "../src/cascade_signals.ts";
import { addTotals, emptyTotals, finalizeTotals, SaleLine } from "../src/reports.ts";

describe("order-independent refund counting in cascade_signals and reports", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "signals-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("item 6: cascade_signals refundRateWindow: [refund(B), reversal(A)] and [reversal(A), refund(B)] give the same counts", () => {
    const asOf = new Date("2026-09-20T12:00:00Z");
    const sale = {
      ts: "2026-09-20T01:00:00.000Z",
      sale_id: "s1",
      provider: "polar",
      product_id: "p1",
      amount_usd: 39,
      creator_id: "c1",
      creator_split_usd: 19.5,
      our_split_usd: 19.5,
      currency: "USD",
      event_type: "sale",
    };
    const refundB = {
      ts: "2026-09-20T02:00:00.000Z",
      sale_id: "s_b",
      provider: "polar",
      product_id: "p1",
      amount_usd: 39,
      creator_id: "c1",
      creator_split_usd: -19.5,
      our_split_usd: -19.5,
      currency: "USD",
      event_type: "refund",
    };
    const reversalA = {
      ts: "2026-09-20T03:00:00.000Z",
      sale_id: "s_a",
      provider: "polar",
      product_id: "p1",
      amount_usd: 39,
      creator_id: "c1",
      creator_split_usd: 19.5,
      our_split_usd: 19.5,
      currency: "USD",
      event_type: "refund_reversal",
    };

    // File 1: refund(B) then reversal(A)
    const file1 = join(tmpDir, "sales1.jsonl");
    writeFileSync(
      file1,
      [JSON.stringify(sale), JSON.stringify(refundB), JSON.stringify(reversalA)].join("\n") + "\n",
      "utf8",
    );

    // File 2: reversal(A) then refund(B)
    const file2 = join(tmpDir, "sales2.jsonl");
    // Make timestamp of reversal earlier than refund so loadSales's ts sort preserves the reversal-first order
    const reversalEarlier = { ...reversalA, ts: "2026-09-20T01:30:00.000Z" };
    writeFileSync(
      file2,
      [JSON.stringify(sale), JSON.stringify(reversalEarlier), JSON.stringify(refundB)].join("\n") + "\n",
      "utf8",
    );

    const res1 = refundRateWindow({ productId: "p1", windowDays: 7, asOf, salesFile: file1 });
    const res2 = refundRateWindow({ productId: "p1", windowDays: 7, asOf, salesFile: file2 });

    // Netting is per sale: the reversal of A must not hide B's refund, in either order.
    expect(res1.refunds).toBe(1);
    expect(res2.refunds).toBe(1);
    expect(res1.refunds).toBe(res2.refunds);
  });

  it("item 6: reports addTotals order independence: [refund, reversal] vs [reversal, refund]", () => {
    const refundLine: SaleLine = {
      ts: "2026-09-20T02:00:00.000Z",
      sale_id: "s_b",
      provider: "polar",
      product_id: "p1",
      amount_usd: 39,
      creator_id: "c1",
      creator_split_usd: -19.5,
      our_split_usd: -19.5,
      currency: "USD",
      event_type: "refund",
    };
    const reversalLine: SaleLine = {
      ts: "2026-09-20T01:30:00.000Z",
      sale_id: "s_a",
      provider: "polar",
      product_id: "p1",
      amount_usd: 39,
      creator_id: "c1",
      creator_split_usd: 19.5,
      our_split_usd: 19.5,
      currency: "USD",
      event_type: "refund_reversal",
    };

    const t1 = emptyTotals();
    addTotals(t1, refundLine);
    addTotals(t1, reversalLine);
    finalizeTotals(t1);

    const t2 = emptyTotals();
    addTotals(t2, reversalLine);
    addTotals(t2, refundLine);
    finalizeTotals(t2);

    // Different sales (B refunded, A reversed): B's refund still counts, in either order.
    expect(t1.refunds).toBe(1);
    expect(t2.refunds).toBe(1);
    expect(t1.refunds).toBe(t2.refunds);
  });

  it("reports: a reversal of the SAME sale nets its refund to 0, in either order", () => {
    const base = { ts: "2026-09-20T01:00:00.000Z", provider: "polar", product_id: "p1", amount_usd: 39, creator_id: "c1", creator_split_pct: 50, creator_split_usd: 19.5, our_split_usd: 19.5, currency: "USD" };
    const refund = { ...base, sale_id: "s_same", event_type: "refund" as const, amount_usd: -39, creator_split_usd: -19.5, our_split_usd: -19.5 };
    const reversal = { ...base, sale_id: "s_same", event_type: "refund_reversal" as const };
    for (const order of [[refund, reversal], [reversal, refund]]) {
      const t = emptyTotals();
      for (const line of order) addTotals(t, line as never);
      finalizeTotals(t);
      expect(t.refunds).toBe(0);
    }
  });
});
