import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  appendSale,
  appendRefund,
  appendRefundReversal,
  findSale,
  findSaleAsync,
  findRefund,
  findRefundReversal,
  findByProviderAdjustmentIdAsync,
  findSalesByAttribution,
  isAdjustmentIdUniqueViolation,
  ORDERS_ADJUSTMENT_UNIQ_INDEX,
  recordWebhookConflict,
  resolveSalesFile,
  SALES_FILE,
  StaleFenceError,
  SaleRecord,
  type RefundSpec,
  type ManualReviewRefund,
} from "../src/ledger.ts";

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

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1" as unknown as number])(
    "rejects invalid fence token (%p) before any durable or local write",
    async (badFence) => {
      const err = await appendSale(baseSale, salesFile, badFence).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).toContain("fence token must be a non-negative safe integer");
      expect(findSale(baseSale.provider, baseSale.sale_id, salesFile)).toBeNull();
    },
  );

  describe("assertSale validation and resolveSalesFile", () => {
    it("rejects non-object/null, invalid strings, non-finite numbers, out-of-range pct, invalid ts, and non-sale event_type", async () => {
      await expect(appendSale(null as unknown as SaleRecord, salesFile)).rejects.toThrow(/must be an object/);
      await expect(appendSale("bad" as unknown as SaleRecord, salesFile)).rejects.toThrow(/must be an object/);
      await expect(appendSale({ ...baseSale, sale_id: "   " }, salesFile)).rejects.toThrow(/"sale_id" must be a non-empty string/);
      await expect(appendSale({ ...baseSale, currency: 123 as unknown as string }, salesFile)).rejects.toThrow(/"currency" must be a non-empty string/);
      await expect(appendSale({ ...baseSale, amount_usd: Number.NaN }, salesFile)).rejects.toThrow(/"amount_usd" must be a finite number/);
      await expect(appendSale({ ...baseSale, our_split_usd: "10" as unknown as number }, salesFile)).rejects.toThrow(/"our_split_usd" must be a finite number/);
      await expect(appendSale({ ...baseSale, creator_split_pct: -1 }, salesFile)).rejects.toThrow(/must be within 0-100/);
      await expect(appendSale({ ...baseSale, creator_split_pct: 101 }, salesFile)).rejects.toThrow(/must be within 0-100/);
      await expect(appendSale({ ...baseSale, ts: "not-a-timestamp" }, salesFile)).rejects.toThrow(/must be a parseable timestamp/);
      await expect(appendSale({ ...baseSale, event_type: "refund" }, salesFile)).rejects.toThrow(/refused non-"sale" event_type/);

      const explicitSale = await appendSale({ ...baseSale, event_type: "sale" }, salesFile);
      expect(explicitSale.sale_id).toBe(baseSale.sale_id);
    });

    it("resolveSalesFile redirects default SALES_FILE to /tmp under VERCEL or AWS_LAMBDA_FUNCTION_NAME", () => {
      vi.stubEnv("VERCEL", "1");
      vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "");
      expect(resolveSalesFile()).toBe(join("/tmp", basename(SALES_FILE)));
      expect(resolveSalesFile("/custom/sales.jsonl")).toBe("/custom/sales.jsonl");

      vi.stubEnv("VERCEL", "");
      vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "fn-payments");
      expect(resolveSalesFile()).toBe(join("/tmp", basename(SALES_FILE)));
    });
  });

  describe("persistToSupabaseOrder error and fenced retry paths", () => {
    it("wraps getSupabaseAdmin construction failure in dual-write error", async () => {
      vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
      vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
      vi.doMock("@supabase/supabase-js", () => ({
        createClient: () => {
          throw new Error("client init boom");
        },
      }));
      try {
        await expect(appendSale(baseSale, salesFile)).rejects.toThrow(/Supabase dual-write failed: client init boom/);
        expect(findSale(baseSale.provider, baseSale.sale_id, salesFile)).toBeNull();
      } finally {
        vi.doUnmock("@supabase/supabase-js");
      }
    });

    it("wraps unexpected runtime errors inside persistToSupabaseOrder try-block", async () => {
      vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
      vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
      vi.doMock("@supabase/supabase-js", () => ({
        createClient: () => ({
          from: () => ({
            upsert: async () => {
              throw new Error("socket hang up");
            },
          }),
        }),
      }));
      try {
        await expect(appendSale(baseSale, salesFile)).rejects.toThrow(/Supabase dual-write failed: socket hang up/);
      } finally {
        vi.doUnmock("@supabase/supabase-js");
      }
    });

    it("throws StaleFenceError on 40001 and preserves error code on non-40001 update error", async () => {
      vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
      vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
      let updateErr: { code: string; message: string } = { code: "40001", message: "stale fence" };
      vi.doMock("@supabase/supabase-js", () => ({
        createClient: () => ({
          from: () => ({
            update: () => {
              const chain = {
                eq: () => chain,
                lte: () => chain,
                select: async () => ({ data: null, error: updateErr }),
              };
              return chain;
            },
          }),
        }),
      }));
      try {
        await expect(appendSale(baseSale, salesFile, 1)).rejects.toBeInstanceOf(StaleFenceError);
        updateErr = { code: "XX000", message: "update db boom" };
        const err = await appendSale(baseSale, salesFile, 1).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "XX000", message: expect.stringContaining("update db boom") });
      } finally {
        vi.doUnmock("@supabase/supabase-js");
      }
    });

    it("succeeds on conditional update retry after 23505 insert race, and throws on checkErr", async () => {
      vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
      vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
      let updateAttempt = 0;
      let retryWins = true;
      let checkErr: { code: string; message: string } | null = null;
      vi.doMock("@supabase/supabase-js", () => ({
        createClient: () => ({
          from: () => ({
            update: () => {
              const chain = {
                eq: () => chain,
                lte: () => chain,
                select: async () => {
                  updateAttempt += 1;
                  if (updateAttempt === 2 && retryWins) {
                    return { data: [{ sale_id: baseSale.sale_id }], error: null };
                  }
                  return { data: [], error: null };
                },
              };
              return chain;
            },
            insert: async () => ({
              error: { code: "23505", message: 'duplicate key value violates unique constraint "orders_provider_sale_id_event_type_key"' },
            }),
            select: () => {
              const chain = {
                eq: () => chain,
                maybeSingle: async () => ({ data: null, error: checkErr }),
              };
              return chain;
            },
          }),
        }),
      }));
      try {
        const rec = await appendSale(baseSale, salesFile, 2);
        expect(rec.sale_id).toBe(baseSale.sale_id);

        updateAttempt = 0;
        retryWins = false;
        checkErr = { code: "42P01", message: "check fence failed" };
        const err = await appendSale({ ...baseSale, sale_id: "sale_check_err" }, salesFile, 2).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "42P01", message: expect.stringContaining("check fence failed") });
      } finally {
        vi.doUnmock("@supabase/supabase-js");
      }
    });
  });

  describe("queryOrderRowFromSupabase, rowToSaleRecord, and isAdjustmentIdUniqueViolation", () => {
    it("formats Date occurred_at via toISOString and wraps non-Error rejections", async () => {
      vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
      vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
      let mode: "date" | "string_reject" = "date";
      vi.doMock("@supabase/supabase-js", () => ({
        createClient: () => ({
          from: () => ({
            select: () => {
              const chain = {
                eq: () => chain,
                maybeSingle: async () => {
                  if (mode === "string_reject") throw "raw string error";
                  return {
                    data: {
                      occurred_at: new Date("2026-10-01T00:00:00.000Z"),
                      sale_id: "sale_date_1",
                      provider: "polar",
                      product_id: "p1",
                      amount_usd: "39",
                      creator_id: "c1",
                      creator_split_pct: "50",
                      creator_split_usd: "19.5",
                      our_split_usd: "19.5",
                      currency: "USD",
                      event_type: "sale",
                    },
                    error: null,
                  };
                },
              };
              return chain;
            },
          }),
        }),
      }));
      try {
        const rec = await findSaleAsync("polar", "sale_date_1", salesFile);
        expect(rec?.ts).toBe("2026-10-01T00:00:00.000Z");

        mode = "string_reject";
        await expect(findSaleAsync("polar", "sale_err_str", salesFile)).rejects.toThrow("raw string error");
      } finally {
        vi.doUnmock("@supabase/supabase-js");
      }
    });

    it("isAdjustmentIdUniqueViolation handles non-objects, non-23505 codes, constraint match, and message match", () => {
      expect(isAdjustmentIdUniqueViolation(null)).toBe(false);
      expect(isAdjustmentIdUniqueViolation("23505")).toBe(false);
      expect(isAdjustmentIdUniqueViolation({ code: "23503", constraint: ORDERS_ADJUSTMENT_UNIQ_INDEX })).toBe(false);
      expect(isAdjustmentIdUniqueViolation({ code: "23505", constraint: ORDERS_ADJUSTMENT_UNIQ_INDEX })).toBe(true);
      expect(isAdjustmentIdUniqueViolation({ code: "23505", message: `violates ${ORDERS_ADJUSTMENT_UNIQ_INDEX}` })).toBe(true);
      expect(isAdjustmentIdUniqueViolation({ code: "23505", message: "other_index" })).toBe(false);
    });
  });

  describe("tolerant local file readers (non-ENOENT, ENOENT, malformed lines)", () => {
    it("treats non-ENOENT read errors (directory EISDIR) and missing files (ENOENT) as empty", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(findSale("polar", "s1", tmpDir)).toBeNull();
        expect(findRefund("polar", "s1", tmpDir)).toBeNull();
        expect(findRefundReversal("polar", "s1", tmpDir)).toBeNull();
        expect(findSalesByAttribution("attr_1", tmpDir)).toEqual([]);
        await expect(findByProviderAdjustmentIdAsync("polar", "adj_1", "refund", tmpDir)).resolves.toBeNull();

        const missing = join(tmpDir, "does-not-exist.jsonl");
        expect(findRefundReversal("polar", "s1", missing)).toBeNull();
        expect(findSalesByAttribution("attr_1", missing)).toEqual([]);
        await expect(findByProviderAdjustmentIdAsync("polar", "adj_1", "refund", missing)).resolves.toBeNull();
        expect(errSpy).toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
      }
    });

    it("skips malformed JSON lines across all ledger readers and finds subsequent valid entries", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const adjRefund = {
        ...baseSale,
        event_type: "refund",
        creator_split_usd: -19.5,
        our_split_usd: -19.5,
        provider_adjustment_id: "adj_99",
      };
      const reversal = { ...baseSale, event_type: "refund_reversal" };
      writeFileSync(
        salesFile,
        [
          "{broken-json",
          JSON.stringify(baseSale),
          JSON.stringify(adjRefund),
          JSON.stringify(reversal),
        ].join("\n") + "\n",
        "utf8",
      );
      try {
        expect(findSale("polar", baseSale.sale_id, salesFile)?.sale_id).toBe(baseSale.sale_id);
        expect(findRefund("polar", baseSale.sale_id, salesFile)?.event_type).toBe("refund");
        expect(findRefundReversal("polar", baseSale.sale_id, salesFile)?.event_type).toBe("refund_reversal");
        expect(findSalesByAttribution("yt_desc_test_123", salesFile)).toHaveLength(3);
        const byAdj = await findByProviderAdjustmentIdAsync("polar", "adj_99", "refund", salesFile);
        expect(byAdj?.provider_adjustment_id).toBe("adj_99");
        await expect(findByProviderAdjustmentIdAsync("polar", "adj_missing", "refund", salesFile)).resolves.toBeNull();
      } finally {
        errSpy.mockRestore();
      }
    });

    it("logs String(parseErr) when a ledger line parse throws a non-Error value", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const parseSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
        throw "non-error-parse-failure";
      });
      writeFileSync(salesFile, ["first-line", JSON.stringify(baseSale)].join("\n") + "\n", "utf8");
      try {
        expect(findSale("polar", baseSale.sale_id, salesFile)?.sale_id).toBe(baseSale.sale_id);
        expect(errSpy).toHaveBeenCalledWith("ledger: malformed ledger line skipped:", "non-error-parse-failure");
      } finally {
        parseSpy.mockRestore();
        errSpy.mockRestore();
      }
    });

    it("skips non-matching valid JSON lines before returning matching records across all ledger readers", async () => {
      const nonMatchingProvider = {
        ...baseSale,
        provider: "paddle",
        sale_id: "sale_target",
        attribution_id: "attr_other",
        provider_adjustment_id: "adj_target",
      };
      const nonMatchingSaleId = {
        ...baseSale,
        provider: "polar",
        sale_id: "sale_other",
        attribution_id: "attr_other",
        event_type: "refund" as const,
        provider_adjustment_id: "adj_other",
      };
      const targetSale = {
        ...baseSale,
        provider: "polar",
        sale_id: "sale_target",
        attribution_id: "attr_target",
      };
      const targetRefund = {
        ...targetSale,
        event_type: "refund" as const,
        creator_split_usd: -19.5,
        our_split_usd: -19.5,
        provider_adjustment_id: "adj_target",
      };
      const nonMatchingEventTypeAdj = {
        ...targetRefund,
        event_type: "refund_reversal" as const,
        sale_id: "sale_other_rev",
        attribution_id: "attr_other",
      };
      const targetReversal = {
        ...targetSale,
        event_type: "refund_reversal" as const,
        attribution_id: "attr_other",
      };

      // Place non-matching valid JSON lines ahead of each reader's target record:
      // - findSale skips paddle/sale_target, polar/sale_other (refund), and polar/sale_target refund
      // - findRefund skips paddle/sale_target, polar/sale_other (refund), and polar/sale_target sale
      // - findRefundReversal skips non-reversal lines and polar/sale_other_rev
      // - findByProviderAdjustmentIdAsync skips paddle/adj_target, polar/adj_other, and refund_reversal/adj_target
      // - findSalesByAttribution skips attr_other lines
      writeFileSync(
        salesFile,
        [
          JSON.stringify(nonMatchingProvider),
          JSON.stringify(nonMatchingSaleId),
          JSON.stringify(nonMatchingEventTypeAdj),
          JSON.stringify(targetRefund),
          JSON.stringify(targetSale),
          JSON.stringify(targetReversal),
        ].join("\n") + "\n",
        "utf8",
      );

      expect(findSale("polar", "sale_target", salesFile)).toEqual(targetSale);
      expect(findRefund("polar", "sale_target", salesFile)).toEqual(targetRefund);
      expect(findRefundReversal("polar", "sale_target", salesFile)).toEqual(targetReversal);
      expect(await findByProviderAdjustmentIdAsync("polar", "adj_target", "refund", salesFile)).toEqual(targetRefund);
      expect(findSalesByAttribution("attr_target", salesFile)).toEqual([targetRefund, targetSale]);
    });
  });

  describe("recordWebhookConflict", () => {
    const validFlag: ManualReviewRefund = {
      provider: "paddle",
      sale_id: "sale_c2",
      refund_id: null,
      reason: "adjustment_id_collision",
      refund_cents: 1000,
      sale_cents: 1000,
      creator_id: "c1",
      occurred_at: "2026-10-04T00:00:00.000Z",
      adjustment_id: "adj_1",
      event_type: "refund",
      conflicting_sale_id: "sale_c1",
      conflicting_cents: 1000,
      conflicting_currency: "USD",
    };
    const incoming = {
      provider: "paddle",
      event_type: "refund" as const,
      sale_id: "sale_c2",
      adjustment_id: "adj_1",
      total_cents: 1000,
      currency: "USD",
      occurred_at: "2026-10-04T00:00:00.000Z",
      refund_id: null,
    };

    it("validates collision flag shape and missing Supabase env", async () => {
      await expect(
        recordWebhookConflict(incoming, { ...validFlag, reason: "amount_mismatch", adjustment_id: undefined, event_type: undefined }),
      ).rejects.toThrow(/requires an adjustment_id_collision flag/);
      await expect(
        recordWebhookConflict(incoming, { ...validFlag, conflicting_sale_id: undefined }),
      ).rejects.toThrow(/requires an adjustment_id_collision flag/);
      await expect(
        recordWebhookConflict(incoming, { ...validFlag, conflicting_cents: undefined }),
      ).rejects.toThrow(/requires an adjustment_id_collision flag/);

      vi.stubEnv("SUPABASE_URL", "");
      vi.stubEnv("SUPABASE_SECRET_KEY", "");
      await expect(recordWebhookConflict(incoming, validFlag)).rejects.toThrow(/Supabase is not configured/);
    });

    it("parses numeric string rpc id and rejects invalid/missing rpc ids", async () => {
      vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
      vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
      let rpcResult: unknown = "42";
      vi.doMock("@supabase/supabase-js", () => ({
        createClient: () => ({
          rpc: async () => ({ data: rpcResult, error: null }),
        }),
      }));
      try {
        await expect(recordWebhookConflict(incoming, validFlag)).resolves.toBe(42);
        rpcResult = 0;
        await expect(recordWebhookConflict(incoming, validFlag)).rejects.toThrow(/returned no id/);
        rpcResult = null;
        await expect(recordWebhookConflict(incoming, validFlag)).rejects.toThrow(/returned no id/);
      } finally {
        vi.doUnmock("@supabase/supabase-js");
      }
    });
  });

  describe("appendRefund and appendRefundReversal validation, email_hash, and async/fenced branches", () => {
    it("appendRefund validates inputs, defaults ts, and copies email_hash", async () => {
      await expect(appendRefund(null as unknown as RefundSpec, salesFile)).rejects.toThrow(/refund must be an object/);
      await expect(appendRefund({ provider: "  ", sale_id: "s1" }, salesFile)).rejects.toThrow(/refund "provider" must be a non-empty string/);
      await expect(appendRefund({ provider: "polar", sale_id: "" }, salesFile)).rejects.toThrow(/refund "sale_id" must be a non-empty string/);
      await expect(appendRefund({ provider: "polar", sale_id: "s1", ts: "bad" }, salesFile)).rejects.toThrow(/refund "ts" must be a parseable timestamp/);

      await appendSale({ ...baseSale, email_hash: "sha256_buyer_1" }, salesFile);
      const ref = await appendRefund({ provider: "polar", sale_id: baseSale.sale_id }, salesFile);
      expect(ref.email_hash).toBe("sha256_buyer_1");
      expect(Number.isNaN(Date.parse(ref.ts))).toBe(false);
    });

    it("appendRefundReversal validates inputs, copies email_hash, uses async refund fallback, and persists fence on duplicate", async () => {
      await expect(appendRefundReversal(null as unknown as RefundSpec, salesFile)).rejects.toThrow(/refund reversal must be an object/);
      await expect(appendRefundReversal({ provider: "", sale_id: "s1" }, salesFile)).rejects.toThrow(/refund reversal "provider" must be a non-empty string/);
      await expect(appendRefundReversal({ provider: "polar", sale_id: "  " }, salesFile)).rejects.toThrow(/refund reversal "sale_id" must be a non-empty string/);
      await expect(appendRefundReversal({ provider: "polar", sale_id: "s1", ts: "bad" }, salesFile)).rejects.toThrow(/refund reversal "ts" must be a parseable timestamp/);
      await expect(appendRefundReversal({ provider: "polar", sale_id: "missing_sale" }, salesFile)).rejects.toThrow(/no recorded sale/);

      // Local sale with email_hash, refund stored only in Supabase -> exercises findRefundAsync fallback
      await appendSale({ ...baseSale, sale_id: "sale_rev_async", email_hash: "sha256_buyer_2" }, salesFile);

      vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
      vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
      let queriedEventType: string | undefined;
      let fenceUpdates = 0;
      const refundRow = {
        occurred_at: "2026-09-19T00:00:00.000Z",
        sale_id: "sale_rev_async",
        provider: "polar",
        product_id: baseSale.product_id,
        amount_usd: baseSale.amount_usd,
        creator_id: baseSale.creator_id,
        creator_split_pct: baseSale.creator_split_pct,
        creator_split_usd: -baseSale.creator_split_usd,
        our_split_usd: -baseSale.our_split_usd,
        currency: baseSale.currency,
        event_type: "refund",
      };
      vi.doMock("@supabase/supabase-js", () => ({
        createClient: () => ({
          from: () => ({
            select: () => {
              const chain = {
                eq: (col: string, val: string) => {
                  if (col === "event_type") queriedEventType = val;
                  return chain;
                },
                maybeSingle: async () => {
                  if (queriedEventType === "refund") return { data: refundRow, error: null };
                  return { data: null, error: null };
                },
              };
              return chain;
            },
            upsert: async () => ({ error: null }),
            update: () => {
              const chain = {
                eq: () => chain,
                lte: () => chain,
                select: async () => {
                  fenceUpdates += 1;
                  return { data: [{ sale_id: "sale_rev_async" }], error: null };
                },
              };
              return chain;
            },
          }),
        }),
      }));
      try {
        const rev1 = await appendRefundReversal({ provider: "polar", sale_id: "sale_rev_async" }, salesFile);
        expect(rev1.event_type).toBe("refund_reversal");
        expect(rev1.email_hash).toBe("sha256_buyer_2");

        // Duplicate reversal with fence triggers persistToSupabaseOrder(alreadyReversal, fence)
        const rev2 = await appendRefundReversal({ provider: "polar", sale_id: "sale_rev_async" }, salesFile, 3);
        expect(rev2).toEqual(rev1);
        expect(fenceUpdates).toBe(1);
      } finally {
        vi.doUnmock("@supabase/supabase-js");
      }
    });
  });
});
