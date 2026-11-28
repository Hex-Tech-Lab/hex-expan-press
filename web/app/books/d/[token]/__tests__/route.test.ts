import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, HEAD } from "../route";
import { tokenHash } from "../../../../../../payments/src/delivery";

const maybeSingleMock = vi.fn();
// The prior-download check: no row by default, so the first download for a link is logged.
const limitMock = vi.fn(async () => ({ data: [] as unknown[], error: null }));
const insertMock = vi.fn();
const createSignedUrlMock = vi.fn();
const listMock = vi.fn();
const SOURCE_ETAG = '"etag-1"';

const fromMock = vi.fn((table: string) => {
  if (table === "download_events") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: maybeSingleMock,
            limit: limitMock,
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
      list: listMock,
    })),
  },
};

vi.mock("../../../../../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => fakeSbAdmin),
}));

describe("GET /books/d/[token] (Buyer delivery route)", () => {
  const validToken = "A".repeat(43);

  beforeEach(() => {
    // The source listing returns the current ETag for whatever object is asked for.
    listMock.mockImplementation(async (_dir: string, opts: { search?: string }) => ({
      data: [{ name: opts.search ?? "", metadata: { eTag: SOURCE_ETAG } }],
      error: null,
    }));
  });

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
    const req = new NextRequest(`https://expanpress.com/books/d/${token}`);
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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns 404 for invalid token format", async () => {
    const req = new NextRequest("https://expanpress.com/books/d/short");
    const res = await GET(req, { params: Promise.resolve({ token: "short" }) });
    expect(res.status).toBe(404);
  });

  it("returns 404 when download link row is missing", async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const req = new NextRequest(`https://expanpress.com/books/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });
    expect(res.status).toBe(404);
  });

  it("a link row with no expires_at fails closed (500) and is never served", async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s1", product_id: "p1", expires_at: null },
      error: null,
    });
    const req = new NextRequest(`https://expanpress.com/books/d/${validToken}`);
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
    const req = new NextRequest(`https://expanpress.com/books/d/${validToken}`);
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

    const req = new NextRequest(`https://expanpress.com/books/d/${validToken}`);
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

    const req = new NextRequest(`https://expanpress.com/books/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("redirects 302 to Supabase Storage signed URL and redacts raw token from logs", async () => {
    const future = new Date(Date.now() + 100000).toISOString();
    // 1. download_events query
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s1", product_id: "p1", expires_at: future, link_generation: 1795798946386 },
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
        link_generation: 1795798946386,
      }),
    );
    expect(JSON.stringify(insertMock.mock.calls)).not.toContain(validToken);
  });

  it("logs only the first download per link: a later request redirects with no second download_completed row", async () => {
    const future = new Date(Date.now() + 100000).toISOString();
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s1", product_id: "p1", expires_at: future, link_generation: 1795798946386 },
      error: null,
    });
    maybeSingleMock.mockResolvedValueOnce({ data: { release_path: "books/test.pdf" }, error: null });
    createSignedUrlMock.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.example/signed/books/test.pdf" },
      error: null,
    });
    // A download_completed row already exists for this token.
    limitMock.mockResolvedValueOnce({ data: [{ id: 4 }], error: null });

    await expectRedirectTo(validToken, "https://supabase.example/signed/books/test.pdf");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("names the saved file by the release convention, not the storage key (UUID path)", async () => {
    const future = new Date(Date.now() + 100000).toISOString();
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s1", product_id: "9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc", expires_at: future, link_generation: 1 },
      error: null,
    });
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        release_path: "release/9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc_release.pdf",
        slug: "sample_the_quiet_workshop",
        release_year: 2026,
        creators: { display_name: "ExpanPress" },
      },
      error: null,
    });
    createSignedUrlMock.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.example/signed/release/x.pdf?token=t&download=ExpanPress_SampleTheQuietWorkshop_ExpanPress_2026.pdf" },
      error: null,
    });
    insertMock.mockResolvedValueOnce({ error: null });

    await expectRedirectTo(validToken, "https://supabase.example/signed/release/x.pdf");
    expect(createSignedUrlMock).toHaveBeenCalledWith(
      "release/9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc_release.pdf",
      expect.any(Number),
      { download: "ExpanPress_SampleTheQuietWorkshop_ExpanPress_2026.pdf" },
    );
  });

  it("still serves, and logs the gap, when the product has no release-filename parts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const future = new Date(Date.now() + 100000).toISOString();
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s1", product_id: "p1", expires_at: future, link_generation: 1 },
      error: null,
    });
    maybeSingleMock.mockResolvedValueOnce({ data: { release_path: "books/bare.pdf", slug: null, release_year: null, creators: null }, error: null });
    createSignedUrlMock.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.example/signed/books/bare.pdf" },
      error: null,
    });
    insertMock.mockResolvedValueOnce({ error: null });

    await expectRedirectTo(validToken, "https://supabase.example/signed/books/bare.pdf");
    expect(createSignedUrlMock).toHaveBeenCalledWith("books/bare.pdf", expect.any(Number));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("release filename incomplete"));
  });

  it("redirects 302 to Cloudflare R2 presigned URL when R2 is configured (0% egress)", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "r2-acc-test");
    vi.stubEnv("R2_ACCESS_KEY_ID", "r2-key-test");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "r2-sec-test");
    vi.stubEnv("R2_BUCKET_NAME", "r2-releases");

    // R2 object present (200) and written from the current source (marker matches the listing)
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200, headers: { "x-amz-meta-supabase-etag": SOURCE_ETAG } }),
    );

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

    const { res } = await expectRedirectTo(validToken, "https://supabase.example/signed/books/fallback-book.pdf");
    expect(createSignedUrlMock).toHaveBeenCalledWith("books/fallback-book.pdf", expect.any(Number));
    expect(insertMock).toHaveBeenCalled();
    // The 302 redirect also carries the header, so the signed URL never leaks the referrer.
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("download responses never leak the /books/d/{token} URL via Referrer-Policy", () => {
  const token = "B".repeat(43);
  const url = `https://expanpress.com/books/d/${token}`;

  it("404 Not Found (branded HTML) sends Referrer-Policy: no-referrer", async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await GET(new NextRequest(url, { headers: { accept: "text/html" } }), {
      params: Promise.resolve({ token }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("410 Gone (branded HTML) sends Referrer-Policy: no-referrer", async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "s1", product_id: "p1", expires_at: new Date(Date.now() - 10000).toISOString() },
      error: null,
    });
    const res = await GET(new NextRequest(url, { headers: { accept: "text/html" } }), {
      params: Promise.resolve({ token }),
    });
    expect(res.status).toBe(410);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("500 Internal Server Error (branded HTML) sends Referrer-Policy: no-referrer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: { message: "db unavailable" } });
    const res = await GET(new NextRequest(url, { headers: { accept: "text/html" } }), {
      params: Promise.resolve({ token }),
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it.each([
    ["404", () => maybeSingleMock.mockResolvedValueOnce({ data: null, error: null }), 404],
    [
      "410",
      () =>
        maybeSingleMock.mockResolvedValueOnce({
          data: { sale_id: "s1", product_id: "p1", expires_at: new Date(Date.now() - 10000).toISOString() },
          error: null,
        }),
      410,
    ],
    [
      "500",
      () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        maybeSingleMock.mockResolvedValueOnce({ data: null, error: { message: "db unavailable" } });
      },
      500,
    ],
  ])("%s plain-text response sends Referrer-Policy: no-referrer", async (_label, arrange, status) => {
    arrange();
    const res = await GET(new NextRequest(url, { headers: { accept: "application/json" } }), {
      params: Promise.resolve({ token }),
    });
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("HEAD probe 404 sends Referrer-Policy: no-referrer", async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await HEAD(new NextRequest(url, { method: "HEAD" }), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(404);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
