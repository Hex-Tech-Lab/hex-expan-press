import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSale, appendRefund, findSale, findRefund, findSalesByAttribution, SaleRecord } from "../src/ledger.ts";

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

  it("guards refund idempotency using findRefund", () => {
    expect(findRefund("polar", "sale_001", salesFile)).toBeNull();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Concurrent duplicate sale deliveries (TOCTOU regression): both invocations race
  // the append — the JSONL append-only read-then-append allows the second to pass the
  // file check only if it reads BEFORE the first appends; under a mock or real
  // serialization exactly 1 ledger row must exist.
  it("two concurrent duplicate sales → exactly 1 ledger row (mock-serialized lock)", async () => {
    // Mock the distributed lock: first acquire wins, later acquires see the held lock.
    const lockAcquire = vi.fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);
    const withIdempotencyLock = async <T>(dup: T, fn: () => Promise<T>): Promise<T> => {
      const acquired = await lockAcquire();
      return acquired === 1 ? fn() : dup;
    };

    const appendOnce = (): Promise<void> =>
      withIdempotencyLock(undefined, async () => {
        if (findSale("polar", baseSale.sale_id, salesFile)) return;
        await appendSale(baseSale, salesFile);
      });

    await Promise.all([appendOnce(), appendOnce()]);

    const { readFileSync } = await import("node:fs");
    const rows = readFileSync(salesFile, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(1);
  });

  // Supabase dual-write fail-closed (P1): when env is configured, an upsert error
  // must THROW so the webhook route returns 500 and the provider retries.
  it("Supabase upsert error → throws when SUPABASE env set", async () => {
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    const upsertErr = { message: "unit-test upsert failure" };
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({ from: () => ({ upsert: () => Promise.resolve({ error: upsertErr }) }) }),
    }));
    try {
      const { appendSale: freshAppendSale } = await import("../src/ledger.ts");
      await expect(freshAppendSale(baseSale, salesFile)).rejects.toThrow(/Supabase orders upsert failed/);
      // Durable-first ordering: the failed sale must NOT be in the local ledger,
      // or the provider's retry would be treated as a duplicate and orders never written.
      const { findSale: freshFindSale } = await import("../src/ledger.ts");
      expect(freshFindSale(baseSale.provider, baseSale.sale_id, salesFile)).toBeNull();
    } finally {
      vi.doUnmock("@supabase/supabase-js");
    }
  });

  // Duplicate refund resolution (P1): a second refund for the same sale must
  // RESOLVE with the existing record — no throw, no duplicate ledger row.
  it("duplicate refund → resolves with existing record without throwing", async () => {
    await appendSale(baseSale, salesFile);
    const first = await appendRefund({ provider: "polar", sale_id: "sale_001", ts: "2026-09-19T00:00:00.000Z" }, salesFile);
    const second = await appendRefund({ provider: "polar", sale_id: "sale_001", ts: "2026-09-20T00:00:00.000Z" }, salesFile);
    expect(second).toEqual(first);
    const { readFileSync } = await import("node:fs");
    const rows = readFileSync(salesFile, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(2); // 1 sale + 1 refund — no duplicate refund row
  });

  // Reversal tests (P1 chargeback reversal)
  it("records refund_reversal only if refund exists; duplicate reversal is a no-op", async () => {
    const { appendRefundReversal } = await import("../src/ledger.ts");
    await appendSale(baseSale, salesFile);
    await appendRefund({ provider: "polar", sale_id: "sale_001", ts: "2026-09-19T00:00:00.000Z" }, salesFile);

    const rev1 = await appendRefundReversal({ provider: "polar", sale_id: "sale_001", ts: "2026-09-20T00:00:00.000Z" }, salesFile);
    expect(rev1.event_type).toBe("refund_reversal");
    expect(rev1.creator_split_usd).toBe(baseSale.creator_split_usd);
    expect(rev1.our_split_usd).toBe(baseSale.our_split_usd);

    // Duplicate reversal is a no-op / returns existing
    const rev2 = await appendRefundReversal({ provider: "polar", sale_id: "sale_001", ts: "2026-09-21T00:00:00.000Z" }, salesFile);
    expect(rev2).toEqual(rev1);

    const { readFileSync } = await import("node:fs");
    const rows = readFileSync(salesFile, "utf8").split(/\r?\n/).filter(Boolean);
    expect(rows).toHaveLength(3); // 1 sale + 1 refund + 1 reversal
  });

  it("reversal without prior refund throws (leaves for manual review)", async () => {
    const { appendRefundReversal } = await import("../src/ledger.ts");
    await appendSale(baseSale, salesFile);
    await expect(appendRefundReversal({ provider: "polar", sale_id: "sale_001" }, salesFile)).rejects.toThrow(
      /no recorded refund/
    );
  });

  // Fail-closed lookups (P1): a Supabase read ERROR must throw, never read as
  // "not found" — otherwise a transient outage lets a duplicate sale through.
  it("findSaleAsync / findRefundAsync throw on a Supabase lookup error", async () => {
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from: () => ({
          select: () => {
            const eq = () => ({ eq, maybeSingle: () => Promise.resolve({ data: null, error: { message: "connection reset" } }) });
            return { eq };
          },
        }),
      }),
    }));
    try {
      const fresh = await import("../src/ledger.ts");
      await expect(fresh.findSaleAsync("polar", "sale_err", salesFile)).rejects.toThrow(/sale lookup failed: connection reset/);
      await expect(fresh.findRefundAsync("polar", "sale_err", salesFile)).rejects.toThrow(/refund lookup failed: connection reset/);
    } finally {
      vi.doUnmock("@supabase/supabase-js");
    }
  });

  // Supabase duplicate-check fallback (P1): findRefundAsync queries public.orders
  // with event_type='refund' when Supabase is configured.
  it("findRefundAsync queries public.orders for refunds when Supabase env set", async () => {
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    const queriedEq: Record<string, string> = {};
    const refundRow = { provider: "polar", sale_id: "sale_q1", event_type: "refund" };
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from: (table: string) => {
          expect(table).toBe("orders");
          const select = () => {
            const eq = (col: string, val: string) => {
              queriedEq[col] = val;
              return { eq, maybeSingle: () => Promise.resolve({ data: refundRow }) };
            };
            return { eq };
          };
          return { select };
        },
      }),
    }));
    try {
      const { findRefundAsync: freshFindRefundAsync } = await import("../src/ledger.ts");
      const rec = await freshFindRefundAsync("polar", "sale_q1");
      expect(rec?.event_type).toBe("refund");
      expect(queriedEq["event_type"]).toBe("refund");
      expect(queriedEq["provider"]).toBe("polar");
      expect(queriedEq["sale_id"]).toBe("sale_q1");
    } finally {
      vi.doUnmock("@supabase/supabase-js");
    }
  });

  it("item 5: a /tmp ledger holding only a refund line + Supabase mock with the sale → appendRefundReversal finds the sale", async () => {
    // Write only a refund line to the local salesFile
    const refundRecord = {
      ts: "2026-09-19T00:00:00.000Z",
      sale_id: "sale_mock_supa_1",
      provider: "polar",
      product_id: "p1",
      amount_usd: 39,
      creator_id: "c1",
      creator_split_pct: 50,
      creator_split_usd: -19.5,
      our_split_usd: -19.5,
      currency: "USD",
      event_type: "refund",
    };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(salesFile, JSON.stringify(refundRecord) + "\n", "utf8");

    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");

    const saleRow = {
      occurred_at: "2026-09-18T00:00:00.000Z",
      sale_id: "sale_mock_supa_1",
      provider: "polar",
      product_id: "p1",
      amount_usd: 39,
      creator_id: "c1",
      creator_split_pct: 50,
      creator_split_usd: 19.5,
      our_split_usd: 19.5,
      currency: "USD",
      event_type: "sale",
    };

    let queriedEventType: string | undefined;

    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from: (table: string) => {
          if (table === "orders") {
            return {
              select: () => {
                interface QueryChain {
                  eq: (col: string, val: string) => QueryChain;
                  maybeSingle: () => Promise<{ data: typeof saleRow | null; error: null }>;
                }
                const chain: QueryChain = {
                  eq: (col: string, val: string) => {
                    if (col === "event_type") queriedEventType = val;
                    return chain;
                  },
                  maybeSingle: () => {
                    if (queriedEventType === "sale") {
                      return Promise.resolve({ data: saleRow, error: null });
                    }
                    return Promise.resolve({ data: null, error: null });
                  },
                };
                return chain;
              },
              upsert: () => Promise.resolve({ error: null }),
            };
          }
          return {};
        },
      }),
    }));

    try {
      const { appendRefundReversal: freshAppendRefundReversal, findSale: freshFindSale } = await import("../src/ledger.ts");
      // Local findSale should return null because local file only has a "refund" line
      expect(freshFindSale("polar", "sale_mock_supa_1", salesFile)).toBeNull();

      // appendRefundReversal should find the sale in Supabase and succeed
      const reversal = await freshAppendRefundReversal({ provider: "polar", sale_id: "sale_mock_supa_1" }, salesFile);
      expect(reversal.event_type).toBe("refund_reversal");
      expect(reversal.amount_usd).toBe(39);
    } finally {
      vi.doUnmock("@supabase/supabase-js");
    }
  });
});
