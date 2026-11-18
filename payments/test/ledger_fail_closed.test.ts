import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSale,
  appendRefund,
  appendRefundReversal,
  findSale,
  findSaleAsync,
  findRefund,
  findRefundReversal,
  findSalesByAttribution,
  findByProviderAdjustmentIdAsync,
  mirrorToLocalLedger,
  type SaleRecord,
} from "../src/ledger.ts";

// Injected I/O faults for the local sales ledger. Only the exact ledger path is affected, so the test's own
// assertions (on other paths, or after the fault is disarmed) read normally. Hoisted for the mock factory.
const fsFault = vi.hoisted(() => ({
  path: null as string | null,
  readCode: null as string | null,
  openCode: null as string | null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const inject = (code: string | null, target: unknown): void => {
    if (code === null || fsFault.path === null || String(target) !== fsFault.path) return;
    throw Object.assign(new Error(`${code}: injected ledger fault`), { code });
  };
  return {
    ...actual,
    readFileSync: ((target: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      inject(fsFault.readCode, target);
      return (actual.readFileSync as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof actual.readFileSync,
    openSync: ((target: Parameters<typeof actual.openSync>[0], ...rest: unknown[]) => {
      inject(fsFault.openCode, target);
      return (actual.openSync as (...args: unknown[]) => number)(target, ...rest);
    }) as typeof actual.openSync,
  };
});

type Row = Record<string, unknown>;

// In-memory public.orders stand-in: upsert appends, select().eq()...maybeSingle() filters by every eq column.
function makeOrdersClient(rows: Row[]) {
  return {
    from: (table: string) => {
      if (table !== "orders") throw new Error(`unexpected table ${table}`);
      return {
        upsert: async (row: Row) => {
          rows.push({ ...row });
          return { error: null };
        },
        select: () => {
          const filters: Row = {};
          const chain = {
            eq: (col: string, val: unknown) => {
              filters[col] = val;
              return chain;
            },
            maybeSingle: async () => ({
              data: rows.find((r) => Object.entries(filters).every(([k, v]) => r[k] === v)) ?? null,
              error: null,
            }),
          };
          return chain;
        },
      };
    },
  };
}

const SALE: SaleRecord = {
  ts: "2026-09-18T12:00:00.000Z",
  sale_id: "sale_fc_1",
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

describe("payments/src/ledger fail-closed reads and retry heal", () => {
  let tmpDir: string;
  let salesFile: string;
  let rows: Row[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ledger-fc-"));
    salesFile = join(tmpDir, "sales.jsonl");
    rows = [];
    fsFault.path = null;
    fsFault.readCode = null;
    fsFault.openCode = null;
  });

  afterEach(() => {
    fsFault.path = null;
    fsFault.readCode = null;
    fsFault.openCode = null;
    vi.unstubAllEnvs();
    vi.doUnmock("@supabase/supabase-js");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const useSupabase = () => {
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => makeOrdersClient(rows) }));
  };
  const withoutSupabase = () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
  };
  const ledgerLines = (): string[] => (existsSync(salesFile) ? readFileSync(salesFile, "utf8").split(/\r?\n/).filter(Boolean) : []);

  describe("H1: a missing Supabase client in a money-path runtime is not 'not found'", () => {
    it("throws from the lookups (refund reversal idempotency included) instead of reporting a miss", async () => {
      withoutSupabase();
      // Outside a money path the missing client is a clean miss, so the setup writes succeed.
      await appendSale(SALE, salesFile);
      await appendRefund({ provider: "polar", sale_id: SALE.sale_id }, salesFile);

      vi.stubEnv("NODE_ENV", "production");
      await expect(findSaleAsync("polar", "sale_ghost", salesFile)).rejects.toThrow(
        /sale lookup unavailable: client not configured in a money-path runtime/,
      );
      // The reversal idempotency check: no local reversal exists, so the lookup must run and fail closed.
      await expect(appendRefundReversal({ provider: "polar", sale_id: SALE.sale_id }, salesFile)).rejects.toThrow(
        /refund_reversal lookup unavailable/,
      );
      expect(ledgerLines().some((l) => l.includes('"event_type":"refund_reversal"'))).toBe(false);
    });

    it("outside a money-path runtime a missing client is still a clean miss", async () => {
      withoutSupabase();
      await expect(findSaleAsync("polar", "sale_ghost", salesFile)).resolves.toBeNull();
    });
  });

  describe("H2: only ENOENT means an empty ledger", () => {
    it("EACCES and EIO throw from every local reader and from the duplicate-check write path", async () => {
      withoutSupabase();
      await appendSale(SALE, salesFile);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        for (const code of ["EACCES", "EIO"] as const) {
          fsFault.path = salesFile;
          fsFault.readCode = code;
          const re = new RegExp(code);
          expect(() => findSale("polar", SALE.sale_id, salesFile)).toThrow(re);
          expect(() => findRefund("polar", SALE.sale_id, salesFile)).toThrow(re);
          expect(() => findRefundReversal("polar", SALE.sale_id, salesFile)).toThrow(re);
          expect(() => findSalesByAttribution("yt_desc_test_123", salesFile)).toThrow(re);
          await expect(findByProviderAdjustmentIdAsync("polar", "adj_1", "refund", salesFile)).rejects.toThrow(re);
          await expect(appendRefund({ provider: "polar", sale_id: SALE.sale_id }, salesFile)).rejects.toThrow(re);
          fsFault.path = null;
          fsFault.readCode = null;
        }
      } finally {
        errSpy.mockRestore();
      }
      // Nothing was appended while the ledger was unreadable.
      expect(ledgerLines()).toHaveLength(1);
    });
  });

  describe("H3: a retry heals a local append that failed after the durable write", () => {
    it("a refund and a reversal whose local append failed are re-appended locally by the retry", async () => {
      useSupabase();
      await appendSale(SALE, salesFile);

      // 1) the durable upsert commits, then the local append fails
      fsFault.path = salesFile;
      fsFault.openCode = "EIO";
      try {
        await expect(appendRefund({ provider: "polar", sale_id: SALE.sale_id }, salesFile)).rejects.toThrow(/EIO/);
      } finally {
        fsFault.path = null;
        fsFault.openCode = null;
      }
      expect(rows.some((r) => r.event_type === "refund")).toBe(true);
      expect(ledgerLines().some((l) => l.includes('"event_type":"refund"'))).toBe(false);

      // 2) retry: the refund is held only in Supabase, so the duplicate path must mirror it locally
      await appendRefund({ provider: "polar", sale_id: SALE.sale_id }, salesFile);
      expect(ledgerLines().filter((l) => l.includes('"event_type":"refund"'))).toHaveLength(1);

      // Same shape for the reversal.
      fsFault.path = salesFile;
      fsFault.openCode = "EIO";
      try {
        await expect(appendRefundReversal({ provider: "polar", sale_id: SALE.sale_id }, salesFile)).rejects.toThrow(/EIO/);
      } finally {
        fsFault.path = null;
        fsFault.openCode = null;
      }
      expect(rows.some((r) => r.event_type === "refund_reversal")).toBe(true);
      await appendRefundReversal({ provider: "polar", sale_id: SALE.sale_id }, salesFile);
      expect(ledgerLines().filter((l) => l.includes('"event_type":"refund_reversal"'))).toHaveLength(1);
    });

    it("a sale whose local append failed is found only in Supabase on retry and is mirrored locally", async () => {
      useSupabase();
      fsFault.path = salesFile;
      fsFault.openCode = "EIO";
      try {
        await expect(appendSale(SALE, salesFile)).rejects.toThrow(/EIO/);
      } finally {
        fsFault.path = null;
        fsFault.openCode = null;
      }
      expect(rows).toHaveLength(1);
      expect(existsSync(salesFile)).toBe(false);

      const found = await findSaleAsync("polar", SALE.sale_id, salesFile);
      expect(found?.sale_id).toBe(SALE.sale_id);
      await mirrorToLocalLedger(found as SaleRecord, salesFile);
      expect(findSale("polar", SALE.sale_id, salesFile)?.amount_usd).toBe(39);
      // Mirroring again is a no-op: the key is already present locally.
      await mirrorToLocalLedger(found as SaleRecord, salesFile);
      expect(ledgerLines()).toHaveLength(1);
    });
  });
});
