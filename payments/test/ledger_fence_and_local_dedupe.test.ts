// PR 136 ledger fixes. (1) An existing orders key takes only the fence: a duplicate or conflicting payload never rewrites
// the committed financial fields, and the full row is inserted only when the key is absent. (2) The local JSONL ledger
// never appends a (provider, sale_id, event_type) line twice, so a stale worker cannot duplicate a newer worker's line.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Row = Record<string, unknown>;
const orders = new Map<string, Row>();
const orderKey = (provider: unknown, saleId: unknown, eventType: unknown) => `${provider}|${saleId}|${eventType}`;

/** A PostgREST-shaped query over the in-memory orders table: eq/lte filters, update, insert with the unique key, maybeSingle. */
class Query {
  private mode: "select" | "update" | "insert" = "select";
  private payload: Row = {};
  private readonly filters: Array<[string, "eq" | "lte", unknown]> = [];
  private single = false;

  constructor(private readonly table: string) {}
  select(): this {
    return this;
  }
  update(payload: Row): this {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  insert(payload: Row): this {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push([column, "eq", value]);
    return this;
  }
  lte(column: string, value: unknown): this {
    this.filters.push([column, "lte", value]);
    return this;
  }
  maybeSingle(): this {
    this.single = true;
    return this;
  }
  private run(): { data: unknown; error: { code?: string; message: string } | null } {
    if (this.table !== "orders") throw new Error(`unexpected table ${this.table}`);
    // SQL semantics: a NULL column never satisfies lte, so a NULL fence is not a match.
    const matches = (row: Row) => this.filters.every(([c, op, v]) => (op === "eq" ? row[c] === v : row[c] !== null && row[c] !== undefined && Number(row[c]) <= Number(v)));
    if (this.mode === "insert") {
      const k = orderKey(this.payload.provider, this.payload.sale_id, this.payload.event_type ?? "sale");
      if (orders.has(k)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint orders_provider_sale_id_event_type_key" } };
      orders.set(k, { ...this.payload });
      return { data: null, error: null };
    }
    const rows = [...orders.values()].filter(matches);
    if (this.mode === "update") {
      for (const row of rows) Object.assign(row, this.payload);
      return { data: rows.map((r) => ({ sale_id: r.sale_id })), error: null };
    }
    return { data: this.single ? (rows[0] ?? null) : rows, error: null };
  }
  // Awaitable like the PostgREST builder: awaiting runs the query once.
  then(onOk?: (v: { data: unknown; error: { code?: string; message: string } | null }) => unknown, onErr?: (e: unknown) => unknown): Promise<unknown> {
    return Promise.resolve().then(() => this.run()).then(onOk, onErr);
  }
}

const SALE_A = {
  ts: "2026-11-18T12:00:00.000Z",
  sale_id: "sale-ledger-fence-1",
  provider: "paddle",
  product_id: "prod-1",
  amount_usd: 10,
  creator_id: "creator_1",
  creator_split_pct: 50,
  creator_split_usd: 5,
  our_split_usd: 5,
  currency: "USD",
};

describe("ledger: existing orders key takes only the fence; local JSONL line is never duplicated", () => {
  let tmpDir: string;
  let salesFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ledger-fence-"));
    salesFile = join(tmpDir, "sales.jsonl");
    orders.clear();
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (table: string) => new Query(table) }) }));
  });

  afterEach(() => {
    vi.doUnmock("@supabase/supabase-js");
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a duplicate payload with a newer fence advances the fence and leaves the financial fields as committed", async () => {
    const { appendSale } = await import("../src/ledger.ts");
    await appendSale(SALE_A, salesFile, 1);
    await appendSale({ ...SALE_A, amount_usd: 99, creator_split_usd: 49.5 }, salesFile, 2);

    const row = orders.get(orderKey("paddle", SALE_A.sale_id, "sale"));
    expect(row).toMatchObject({ amount_usd: 10, creator_split_usd: 5, fence: 2 });
  });

  it("a stale fence is refused and changes nothing, in the orders row or the local file", async () => {
    const { appendSale, StaleFenceError } = await import("../src/ledger.ts");
    await appendSale(SALE_A, salesFile, 2);
    await expect(appendSale({ ...SALE_A, amount_usd: 77 }, salesFile, 1)).rejects.toBeInstanceOf(StaleFenceError);

    expect(orders.get(orderKey("paddle", SALE_A.sale_id, "sale"))).toMatchObject({ amount_usd: 10, fence: 2 });
    expect(readFileSync(salesFile, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("a second worker for the same key does not append a second local line", async () => {
    const { appendSale } = await import("../src/ledger.ts");
    await appendSale(SALE_A, salesFile, 1);
    await appendSale(SALE_A, salesFile, 2);

    const lines = readFileSync(salesFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ provider: "paddle", sale_id: SALE_A.sale_id, amount_usd: 10 });
  });

  it("a key absent from the local file is appended, and a different sale is never mistaken for a duplicate", async () => {
    const { appendSale } = await import("../src/ledger.ts");
    await appendSale(SALE_A, salesFile, 1);
    await appendSale({ ...SALE_A, sale_id: "sale-ledger-fence-2" }, salesFile, 1);

    expect(readFileSync(salesFile, "utf8").trim().split("\n")).toHaveLength(2);
  });

  // A stored fence that is not a non-negative integer (SQL NULL, NaN) marks a corrupt row. The write must fail closed:
  // it throws, and neither the orders row nor the local file changes. Treating it as fence 0 would let any worker through.
  it.each<[string, unknown]>([
    ["null", null],
    ["NaN", Number.NaN],
  ])("a stored fence of %s is corrupt: the write throws and changes nothing", async (_label, storedFence) => {
    const { appendSale } = await import("../src/ledger.ts");
    orders.set(orderKey("paddle", SALE_A.sale_id, "sale"), { provider: "paddle", sale_id: SALE_A.sale_id, event_type: "sale", amount_usd: 10, fence: storedFence });

    await expect(appendSale(SALE_A, salesFile, 3)).rejects.toThrow("ledger: Supabase dual-write failed");
    expect(orders.get(orderKey("paddle", SALE_A.sale_id, "sale"))).toMatchObject({ amount_usd: 10, fence: storedFence });
    expect(existsSync(salesFile)).toBe(false);
  });
});
