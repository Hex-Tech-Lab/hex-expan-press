import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { tokenHash } from "../../../../../payments/src/delivery";

const maybeSingleMock = vi.fn();
const insertMock = vi.fn();
const createSignedUrlMock = vi.fn();

const fromMock = vi.fn((table: string) => {
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
});
