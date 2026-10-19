import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSupabaseAdmin } from "../src/supabase_admin";
import { productionDeps } from "../src/delivery";

// The production DB adapter, reached through productionDeps().db. A fake Supabase client records every
// table call and returns queued results, so each money-path branch can be driven directly.

type Result = { data?: unknown; error?: { code?: string; message: string } | null };
type Call = { table: string; ops: Array<[string, unknown[]]> };

const calls: Call[] = [];
let results: Result[] = [];

function fakeClient() {
  return {
    from(table: string) {
      const rec: Call = { table, ops: [] };
      calls.push(rec);
      const result: Result = results.shift() ?? { data: null, error: null };
      const chain = {
        then: (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
        select: (...a: unknown[]) => (rec.ops.push(["select", a]), chain),
        insert: (...a: unknown[]) => (rec.ops.push(["insert", a]), chain),
        delete: (...a: unknown[]) => (rec.ops.push(["delete", a]), chain),
        eq: (...a: unknown[]) => (rec.ops.push(["eq", a]), chain),
        contains: (...a: unknown[]) => (rec.ops.push(["contains", a]), chain),
        order: (...a: unknown[]) => (rec.ops.push(["order", a]), chain),
        limit: (...a: unknown[]) => (rec.ops.push(["limit", a]), chain),
        maybeSingle: (...a: unknown[]) => (rec.ops.push(["maybeSingle", a]), chain),
      };
      return chain;
    },
  };
}

vi.mock("../src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn() }));

const useClient = () =>
  vi.mocked(getSupabaseAdmin).mockResolvedValue(fakeClient() as unknown as Awaited<ReturnType<typeof getSupabaseAdmin>>);

const db = () => productionDeps().db;
const EXPIRES = new Date("2026-10-25T00:00:00Z");

beforeEach(() => {
  calls.length = 0;
  results = [];
});

describe("supabaseDeliveryDb: recordLinkIssued", () => {
  it("inserts a link_issued row and returns true on success", async () => {
    useClient();
    results = [{ data: null, error: null }];
    const ok = await db().recordLinkIssued({ saleId: "s-1", productId: "p-1", tokenHash: "h".repeat(64), expiresAt: EXPIRES });
    expect(ok).toBe(true);
    const insert = calls[0].ops.find(([op]) => op === "insert")![1][0] as Record<string, unknown>;
    expect(calls[0].table).toBe("download_events");
    expect(insert).toMatchObject({ sale_id: "s-1", product_id: "p-1", token_hash: "h".repeat(64), event_type: "link_issued" });
    expect(insert.expires_at).toBe(EXPIRES.toISOString());
  });

  it("returns false on unique violation 23505 (one link per sale)", async () => {
    useClient();
    results = [{ data: null, error: { code: "23505", message: "duplicate key" } }];
    const ok = await db().recordLinkIssued({ saleId: "s-1", productId: "p-1", tokenHash: "h".repeat(64), expiresAt: EXPIRES });
    expect(ok).toBe(false);
  });

  it("throws on any other insert error, so the webhook retries", async () => {
    useClient();
    results = [{ data: null, error: { code: "08006", message: "connection lost" } }];
    await expect(
      db().recordLinkIssued({ saleId: "s-1", productId: "p-1", tokenHash: "h".repeat(64), expiresAt: EXPIRES }),
    ).rejects.toThrow(/link insert failed: connection lost/);
  });

  it("throws when the admin client is unavailable", async () => {
    vi.mocked(getSupabaseAdmin).mockResolvedValue(null);
    await expect(
      db().recordLinkIssued({ saleId: "s-1", productId: "p-1", tokenHash: "h".repeat(64), expiresAt: EXPIRES }),
    ).rejects.toThrow(/Supabase admin client unavailable/);
  });
});

describe("supabaseDeliveryDb: productForAlias", () => {
  it("matches a non-UUID alias on store_product_id, then paddle_product_id, never id", async () => {
    useClient();
    results = [
      { data: null, error: null },
      { data: { id: "p-9", title: "Book", release_path: "r/file.pdf" }, error: null },
    ];
    const product = await db().productForAlias("paddle-alias");
    expect(product).toEqual({ id: "p-9", title: "Book", releasePath: "r/file.pdf" });
    expect(calls.map((c) => c.ops.find(([op]) => op === "eq")![1])).toEqual([
      ["store_product_id", "paddle-alias"],
      ["paddle_product_id", "paddle-alias"],
    ]);
  });

  it("also matches a UUID alias on id", async () => {
    useClient();
    const uuid = "11111111-1111-4111-8111-111111111111";
    results = [
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: uuid, title: null, release_path: null }, error: null },
    ];
    const product = await db().productForAlias(uuid);
    expect(product).toEqual({ id: uuid, title: "your ExpanPress title", releasePath: null });
    const lastColumn = calls[2].ops.find(([op]) => op === "eq")![1][0];
    expect(lastColumn).toBe("id");
  });

  it("returns null when no column matches", async () => {
    useClient();
    results = [
      { data: null, error: null },
      { data: null, error: null },
    ];
    expect(await db().productForAlias("unknown-alias")).toBeNull();
  });

  it("throws on a lookup error instead of reporting the product as missing", async () => {
    useClient();
    results = [{ data: null, error: { message: "timeout" } }];
    await expect(db().productForAlias("paddle-alias")).rejects.toThrow(/product lookup failed: timeout/);
  });
});

describe("supabaseDeliveryDb: confirmation and release", () => {
  it("deliveryConfirmed is true only when a DELIVERY_LINK_SENT row exists for the sale", async () => {
    useClient();
    results = [{ data: [{ id: 1 }], error: null }];
    expect(await db().deliveryConfirmed("s-1")).toBe(true);
    results = [{ data: [], error: null }];
    expect(await db().deliveryConfirmed("s-2")).toBe(false);
  });

  it("deliveryConfirmed throws on a lookup error rather than reporting unconfirmed", async () => {
    useClient();
    results = [{ data: null, error: { message: "boom" } }];
    await expect(db().deliveryConfirmed("s-1")).rejects.toThrow(/delivery confirmation lookup failed: boom/);
  });

  it("confirmDelivery writes the audit row keyed by sale_id and token_hash", async () => {
    useClient();
    results = [{ data: null, error: null }];
    await db().confirmDelivery({ saleId: "s-1", tokenHash: "h".repeat(64) });
    expect(calls[0].table).toBe("audit_log");
    const row = calls[0].ops.find(([op]) => op === "insert")![1][0] as { event: string; details: unknown };
    expect(row.event).toBe("DELIVERY_LINK_SENT");
    expect(row.details).toEqual({ sale_id: "s-1", token_hash: "h".repeat(64) });
  });

  it("confirmDelivery throws on a write error", async () => {
    useClient();
    results = [{ data: null, error: { message: "write refused" } }];
    await expect(db().confirmDelivery({ saleId: "s-1", tokenHash: "h".repeat(64) })).rejects.toThrow(
      /delivery confirmation write failed: write refused/,
    );
  });

  it("releaseLinkIssued deletes only the link_issued row for that sale and hash, and throws on error", async () => {
    useClient();
    results = [{ data: null, error: null }];
    await db().releaseLinkIssued({ saleId: "s-1", tokenHash: "h".repeat(64) });
    expect(calls[0].table).toBe("download_events");
    expect(calls[0].ops).toEqual([
      ["delete", []],
      ["eq", ["sale_id", "s-1"]],
      ["eq", ["token_hash", "h".repeat(64)]],
      ["eq", ["event_type", "link_issued"]],
    ]);
    results = [{ data: null, error: { message: "locked" } }];
    await expect(db().releaseLinkIssued({ saleId: "s-1", tokenHash: "h".repeat(64) })).rejects.toThrow(
      /link release failed: locked/,
    );
  });

  it("releaseOrphanedLinks throws on error", async () => {
    useClient();
    results = [{ data: null, error: { message: "locked" } }];
    await expect(db().releaseOrphanedLinks("s-1")).rejects.toThrow(/orphan link release failed: locked/);
  });
});
