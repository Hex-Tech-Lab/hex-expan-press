import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { tokenHash } from "../../../../../payments/src/delivery";

const maybeSingleMock = vi.fn();
const insertMock = vi.fn();
const createSignedUrlMock = vi.fn();

type Row = Record<string, unknown>;
type QueryResult = { data: Row[] | null; error: { message: string } | null };

// Table contents for the fake Supabase client. Each test seeds what it needs in beforeEach or in the test.
const tableRows: Record<string, Row[]> = {};
const tableError: Record<string, { message: string } | null> = {};

/**
 * A chainable stand-in for a PostgREST read. It applies eq filters, one order and a limit to its rows, as the
 * server does, so a query that drops its sale_id filter returns other sales' rows and changes the outcome.
 * A column path with "->>" reads a key inside a jsonb object (for example "details->>sale_id").
 */
interface ReadBuilder extends PromiseLike<QueryResult> {
  select(...args: unknown[]): ReadBuilder;
  eq(column: string, value: unknown): ReadBuilder;
  order(column: string, opts?: { ascending?: boolean }): ReadBuilder;
  limit(n: number): ReadBuilder;
}

function readPath(row: Row, path: string): unknown {
  const [head, key] = path.split("->>");
  if (key === undefined) return row[head];
  return (row[head] as Record<string, unknown> | undefined)?.[key];
}

function readBuilder(table: string): ReadBuilder {
  const filters: Array<[string, unknown]> = [];
  let sort: { column: string; ascending: boolean } | null = null;
  let limitN: number | null = null;

  const run = (): QueryResult => {
    const error = tableError[table] ?? null;
    if (error) return { data: null, error };
    let rows = (tableRows[table] ?? []).filter((r) => filters.every(([c, v]) => readPath(r, c) === v));
    if (sort) {
      const { column, ascending } = sort;
      rows = [...rows].sort((a, b) => {
        const x = String(readPath(a, column));
        const y = String(readPath(b, column));
        return x === y ? 0 : (x < y ? -1 : 1) * (ascending ? 1 : -1);
      });
    }
    if (limitN !== null) rows = rows.slice(0, limitN);
    return { data: rows, error: null };
  };

  const builder: ReadBuilder = {
    select: () => builder,
    eq: (column, value) => {
      filters.push([column, value]);
      return builder;
    },
    order: (column, opts) => {
      sort = { column, ascending: opts?.ascending !== false };
      return builder;
    },
    limit: (n) => {
      limitN = n;
      return builder;
    },
    then: (onfulfilled, onrejected) => Promise.resolve(run()).then(onfulfilled, onrejected),
  };
  return builder;
}

const fromMock = vi.fn((table: string) => {
  if (table === "orders" || table === "audit_log") {
    return { select: vi.fn(() => readBuilder(table)) };
  }
  if (table === "download_events") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: maybeSingleMock,
          })),
        })),
      })),
      insert: insertMock,
    };
  }
  if (table === "products") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: maybeSingleMock,
        })),
      })),
    };
  }
  return {};
});

const fakeSbAdmin = {
  from: fromMock,
  storage: {
    from: vi.fn(() => ({
      createSignedUrl: createSignedUrlMock,
    })),
  },
};

vi.mock("../../../../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => fakeSbAdmin),
}));

const ledgerRow = (sale_id: string, event_type: string, created_at: string, provider = "paddle"): Row => ({
  sale_id,
  provider,
  event_type,
  created_at,
  occurred_at: created_at,
});
const saleRow = (sale_id: string): Row => ledgerRow(sale_id, "sale", "2026-10-01T00:00:00Z");

describe("GET /d/[token] (Buyer delivery route)", () => {
  const validToken = "A".repeat(43);

  function clearR2Envs() {
    vi.stubEnv("R2_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("R2_ACCESS_KEY_ID", "");
    vi.stubEnv("CLOUDFLARE_R2_ACCESS_KEY_ID", "");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "");
    vi.stubEnv("CLOUDFLARE_R2_SECRET_ACCESS_KEY", "");
    vi.stubEnv("R2_BUCKET_NAME", "");
    vi.stubEnv("CLOUDFLARE_R2_BUCKET", "");
  }

  async function expectRedirectTo(token: string, expectedUrlSubstring: string) {
    const req = new NextRequest(`https://expanpress.com/d/${token}`);
    const res = await GET(req, { params: Promise.resolve({ token }) });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(expectedUrlSubstring);
    return { res, location };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    clearR2Envs();
    maybeSingleMock.mockReset();
    createSignedUrlMock.mockReset();
    insertMock.mockReset();
    // Every sale these tests use has a plain sale row (un-refunded). A test that needs a refund sets its own rows.
    for (const k of Object.keys(tableRows)) delete tableRows[k];
    for (const k of Object.keys(tableError)) delete tableError[k];
    tableRows.orders = ["s1", "s2", "s3", "s-refund", "s-flag", "s-a", "s-b"].map(saleRow);
    tableRows.audit_log = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns 404 for invalid token format", async () => {
    const req = new NextRequest("https://expanpress.com/d/short");
    const res = await GET(req, { params: Promise.resolve({ token: "short" }) });
    expect(res.status).toBe(404);
  });

  it("returns 404 when download link row is missing", async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });
    expect(res.status).toBe(404);
  });

  it("a link row with no expires_at fails closed (500) and is never served", async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s1", product_id: "p1", expires_at: null },
      error: null,
    });
    const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns 410 when download link is expired", async () => {
    const past = new Date(Date.now() - 10000).toISOString();
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s1", product_id: "p1", expires_at: past },
      error: null,
    });
    const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("expired");
  });

  it("serves nothing when the download log write fails (fail closed)", async () => {
    const future = new Date(Date.now() + 100000).toISOString();
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s1", product_id: "p1", expires_at: future },
      error: null,
    });
    maybeSingleMock.mockResolvedValueOnce({
      data: { release_path: "books/test.pdf" },
      error: null,
    });
    createSignedUrlMock.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.example/signed/books/test.pdf" },
      error: null,
    });
    insertMock.mockResolvedValueOnce({ error: { message: "insert failed" } });

    const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("500s when signed URL cannot be created (with no Location header)", async () => {
    const future = new Date(Date.now() + 100000).toISOString();
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s1", product_id: "p1", expires_at: future },
      error: null,
    });
    maybeSingleMock.mockResolvedValueOnce({
      data: { release_path: "books/test.pdf" },
      error: null,
    });
    createSignedUrlMock.mockResolvedValueOnce({
      data: null,
      error: { message: "storage signing failed" },
    });

    const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("redirects 302 to Supabase Storage signed URL and redacts raw token from logs", async () => {
    const future = new Date(Date.now() + 100000).toISOString();
    // 1. download_events query
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s1", product_id: "p1", expires_at: future },
      error: null,
    });
    // 2. products query
    maybeSingleMock.mockResolvedValueOnce({
      data: { release_path: "books/test.pdf" },
      error: null,
    });
    // 3. storage signing
    createSignedUrlMock.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.example/signed/books/test.pdf" },
      error: null,
    });
    // 4. download_completed insert
    insertMock.mockResolvedValueOnce({ error: null });

    const { res } = await expectRedirectTo(validToken, "https://supabase.example/signed/books/test.pdf");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sale_id: "s1",
        product_id: "p1",
        event_type: "download_completed",
        token_hash: tokenHash(validToken),
      }),
    );
    expect(JSON.stringify(insertMock.mock.calls)).not.toContain(validToken);
  });

  it("redirects 302 to Cloudflare R2 presigned URL when R2 is configured (0% egress)", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "r2-acc-test");
    vi.stubEnv("R2_ACCESS_KEY_ID", "r2-key-test");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "r2-sec-test");
    vi.stubEnv("R2_BUCKET_NAME", "r2-releases");

    // R2 object presence check succeeds (200)
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const future = new Date(Date.now() + 100000).toISOString();
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s2", product_id: "p2", expires_at: future },
      error: null,
    });
    maybeSingleMock.mockResolvedValueOnce({
      data: { release_path: "books/r2-book.pdf" },
      error: null,
    });
    insertMock.mockResolvedValueOnce({ error: null });

    const { location } = await expectRedirectTo(
      validToken,
      "https://r2-acc-test.r2.cloudflarestorage.com/r2-releases/books/r2-book.pdf",
    );
    expect(location).toContain("X-Amz-Signature=");
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalled();
  });

  it("falls back to Supabase Storage when R2 returns null / object missing (404)", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "r2-acc-test");
    vi.stubEnv("R2_ACCESS_KEY_ID", "r2-key-test");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "r2-sec-test");
    vi.stubEnv("R2_BUCKET_NAME", "r2-releases");

    // R2 object presence check returns 404 (absent)
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));

    const future = new Date(Date.now() + 100000).toISOString();
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s3", product_id: "p3", expires_at: future },
      error: null,
    });
    maybeSingleMock.mockResolvedValueOnce({
      data: { release_path: "books/fallback-book.pdf" },
      error: null,
    });
    createSignedUrlMock.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.example/signed/books/fallback-book.pdf" },
      error: null,
    });
    insertMock.mockResolvedValueOnce({ error: null });

    await expectRedirectTo(validToken, "https://supabase.example/signed/books/fallback-book.pdf");
    expect(createSignedUrlMock).toHaveBeenCalledWith("books/fallback-book.pdf", expect.any(Number));
    expect(insertMock).toHaveBeenCalled();
  });

  describe("refund revocation (sale access state)", () => {
    const future = () => new Date(Date.now() + 100000).toISOString();

    function linkRow(saleId = "s-refund") {
      maybeSingleMock.mockResolvedValueOnce({
        data: { sale_id: saleId, product_id: "p-refund", expires_at: future() },
        error: null,
      });
    }

    /** Queues the rest of a successful serve: product lookup, signed URL, and the download log write. */
    function queueServePath() {
      maybeSingleMock.mockResolvedValueOnce({ data: { release_path: "books/test.pdf" }, error: null });
      createSignedUrlMock.mockResolvedValueOnce({ data: { signedUrl: "https://supabase.example/signed/books/test.pdf" }, error: null });
      insertMock.mockResolvedValueOnce({ error: null });
    }

    it("a refunded sale gets 410, no signed URL, and no download logged", async () => {
      tableRows.orders = [saleRow("s-refund"), ledgerRow("s-refund", "refund", "2026-10-05T00:00:00Z")];
      linkRow();
      // The full success path is queued, so without the revocation check the route serves the file (302).
      queueServePath();

      const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
      const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(410);
      expect(await res.text()).toContain("refunded");
      expect(res.headers.get("location")).toBeNull();
      expect(createSignedUrlMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("a refund the provider reversed (won dispute) is served again", async () => {
      tableRows.orders = [
        saleRow("s-refund"),
        ledgerRow("s-refund", "refund", "2026-10-05T00:00:00Z"),
        ledgerRow("s-refund", "refund_reversal", "2026-10-09T00:00:00Z"),
      ];
      linkRow();
      queueServePath();

      await expectRedirectTo(validToken, "https://supabase.example/signed/books/test.pdf");
    });

    it("a sale is served when another sale's refund is in the ledger (the query is scoped by sale_id)", async () => {
      // s-b is refunded; s-a is not. Serving s-a requires the ledger read to filter to s-a's rows.
      tableRows.orders = [saleRow("s-a"), saleRow("s-b"), ledgerRow("s-b", "refund", "2026-10-05T00:00:00Z")];
      linkRow("s-a");
      queueServePath();

      await expectRedirectTo(validToken, "https://supabase.example/signed/books/test.pdf");
    });

    it("fails closed (500, nothing served) when the sale's ledger read errors", async () => {
      tableError.orders = { message: "orders unreachable" };
      linkRow();
      // Success path queued: only a fail-closed ledger check stops the file being served.
      queueServePath();

      const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
      const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(500);
      expect(res.headers.get("location")).toBeNull();
      expect(createSignedUrlMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("fails closed (500) when the sale has no ledger sale row", async () => {
      tableRows.orders = [];
      linkRow();
      // Success path queued: only a fail-closed ledger check stops the file being served.
      queueServePath();

      const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
      const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

      expect(res.status).toBe(500);
      expect(res.headers.get("location")).toBeNull();
      expect(createSignedUrlMock).not.toHaveBeenCalled();
    });

    // A refund that arrives after a reversal is answered 200 and flagged (audit_log MANUAL_REVIEW_REQUIRED_REFUND,
    // reason refund_after_reversal). The ledger still shows the sale active, so the flag alone must deny.
    describe("a sale flagged for manual review", () => {
      function activeSaleWithFlag(saleId: string, flagSaleId = saleId) {
        tableRows.orders = [
          saleRow(saleId),
          ledgerRow(saleId, "refund", "2026-10-05T00:00:00Z"),
          ledgerRow(saleId, "refund_reversal", "2026-10-09T00:00:00Z"),
        ];
        tableRows.audit_log = [
          {
            event: "MANUAL_REVIEW_REQUIRED_REFUND",
            details: { provider: "paddle", sale_id: flagSaleId, reason: "refund_after_reversal" },
          },
        ];
      }

      it("a flagged sale gets 410, no signed URL, and no download logged, even though the ledger shows it active", async () => {
        activeSaleWithFlag("s-flag");
        linkRow("s-flag");
        // The full success path is queued, so without the flag check the route serves the file (302).
        queueServePath();

        const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
        const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

        expect(res.status).toBe(410);
        expect(res.headers.get("location")).toBeNull();
        expect(createSignedUrlMock).not.toHaveBeenCalled();
        expect(insertMock).not.toHaveBeenCalled();
      });

      it("a flag on another sale does not deny this sale", async () => {
        activeSaleWithFlag("s-other", "s-other");
        tableRows.orders = [...(tableRows.orders ?? []), saleRow("s-flag")];
        linkRow("s-flag");
        queueServePath();

        await expectRedirectTo(validToken, "https://supabase.example/signed/books/test.pdf");
      });

      it("fails closed (500, nothing served) when the review-flag read errors", async () => {
        tableError.audit_log = { message: "audit_log unreachable" };
        linkRow();
        queueServePath();

        const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
        const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

        expect(res.status).toBe(500);
        expect(res.headers.get("location")).toBeNull();
        expect(createSignedUrlMock).not.toHaveBeenCalled();
        expect(insertMock).not.toHaveBeenCalled();
      });
    });
  });
});
