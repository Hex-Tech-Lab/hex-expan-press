// Zod gate before orders.upsert (Sprint 11): invalid rows never reach Supabase.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const db = vi.hoisted(() => ({ upserts: [] as Array<{ row: Record<string, unknown>; opts: unknown }> }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      upsert: async (row: Record<string, unknown>, opts: unknown) => {
        db.upserts.push({ row, opts });
        return { error: null };
      },
    }),
  }),
}));

import { appendSale, OrderUpsertSchema, type SaleRecord } from "../src/ledger.ts";

const sale: SaleRecord = {
  ts: "2026-10-04T00:00:00.000Z",
  sale_id: "sale_zod_1",
  provider: "polar",
  product_id: "p1",
  amount_usd: 39,
  creator_id: "c1",
  creator_split_pct: 50,
  creator_split_usd: 19.5,
  our_split_usd: 19.5,
  currency: "USD",
};

describe("orders upsert Zod boundary", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orders-zod-"));
    db.upserts = [];
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("a valid sale is parsed and upserted with the exact column set and conflict target", async () => {
    await appendSale(sale, join(dir, "sales.jsonl"));
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]!.opts).toEqual({ onConflict: "provider,sale_id,event_type" });
    expect(db.upserts[0]!.row).toEqual({
      provider: "polar", sale_id: "sale_zod_1", product_id: "p1", creator_id: "c1",
      amount_usd: 39, creator_split_pct: 50, creator_split_usd: 19.5, our_split_usd: 19.5,
      currency: "USD", event_type: "sale", email_hash: null, attribution_id: null,
      provider_adjustment_id: null, occurred_at: "2026-10-04T00:00:00.000Z",
    });
  });

  it.each([
    ["sub-cent amount", { amount_usd: 39.005 }, /amount_usd/],
    ["near-cent amount (39.000000001)", { amount_usd: 39.000000001 }, /amount_usd/],
    ["sub-cent split", { creator_split_usd: 19.499 }, /creator_split_usd/],
    ["negative amount", { amount_usd: -1 }, /amount_usd/],
    ["negative split on a sale row", { creator_split_usd: -19.5, our_split_usd: -19.5 }, /must be >= 0 on a sale row/],
    ["amount over numeric(10,2)", { amount_usd: 100_000_000 }, /amount_usd/],
    ["pct with 3 decimals", { creator_split_pct: 33.333 }, /creator_split_pct/],
  ])("%s → rejected before the DB, nothing upserted", async (_name, patch, msg) => {
    await expect(appendSale({ ...sale, ...patch }, join(dir, "sales.jsonl"))).rejects.toThrow(msg);
    expect(db.upserts).toHaveLength(0);
  });

  it("refund rows carry negated splits; positive splits on a refund row are rejected", () => {
    const rest: Record<string, unknown> = { ...sale, event_type: "refund", email_hash: null, attribution_id: null, provider_adjustment_id: null, occurred_at: sale.ts };
    delete rest.ts;
    expect(OrderUpsertSchema.safeParse({ ...rest, creator_split_usd: -19.5, our_split_usd: -19.5 }).success).toBe(true);
    expect(OrderUpsertSchema.safeParse(rest).success).toBe(false);
  });

  it.each([0.1 + 0.2, 1.15, 4.35, 1.005 * 1000, 99_999_999.99])("accepts float-noisy cent value %s as cent-exact", (amount) => {
    const row = { ...sale, amount_usd: amount, event_type: "sale", email_hash: null, attribution_id: null, provider_adjustment_id: null, occurred_at: sale.ts };
    const rest: Record<string, unknown> = { ...row };
    delete rest.ts;
    expect(OrderUpsertSchema.safeParse(rest).success).toBe(true);
  });

  it("strict: an unknown column is rejected", () => {
    const rest: Record<string, unknown> = { ...sale, event_type: "sale", email_hash: null, attribution_id: null, provider_adjustment_id: null, occurred_at: sale.ts };
    delete rest.ts;
    expect(OrderUpsertSchema.safeParse({ ...rest, amount_cents: 3900 }).success).toBe(false);
  });
});
