import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

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

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("redirects 302 to Supabase Storage signed URL when R2 is unconfigured", async () => {
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

    const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://supabase.example/signed/books/test.pdf");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sale_id: "s1",
        product_id: "p1",
        event_type: "download_completed",
      }),
    );
  });

  it("redirects 302 to Cloudflare R2 presigned URL when R2 is configured (0% egress)", async () => {
    process.env.R2_ACCOUNT_ID = "r2-acc-test";
    process.env.R2_ACCESS_KEY_ID = "r2-key-test";
    process.env.R2_SECRET_ACCESS_KEY = "r2-sec-test";
    process.env.R2_BUCKET_NAME = "r2-releases";

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

    const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://r2-acc-test.r2.cloudflarestorage.com/r2-releases/books/r2-book.pdf");
    expect(location).toContain("X-Amz-Signature=");
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalled();
  });
});
