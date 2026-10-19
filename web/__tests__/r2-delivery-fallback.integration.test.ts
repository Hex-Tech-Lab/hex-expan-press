import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../app/d/[token]/route";
import { tokenHash } from "../../payments/src/delivery";

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

vi.mock("../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => fakeSbAdmin),
}));

describe("Automated Integration Test: R2 Object Delivery & Fallback Behavior (/d/[token])", () => {
  const validToken = "B".repeat(43);
  const futureExpiry = new Date(Date.now() + 3600 * 1000).toISOString();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function setupValidDownloadRow(releasePath = "books/launch-playbook.pdf") {
    // 1. download_events lookup (finding the active download token)
    maybeSingleMock.mockResolvedValueOnce({
      data: { sale_id: "sale-xyz-123", product_id: "prod-abc-456", expires_at: futureExpiry },
      error: null,
    });
    // 2. products lookup (finding the release file path)
    maybeSingleMock.mockResolvedValueOnce({
      data: { release_path: releasePath },
      error: null,
    });
    // 3. download_completed event insertion
    insertMock.mockResolvedValueOnce({ error: null });
  }

  it("CASE 1 (Optimal Egress): R2 configured & object present -> serves R2 presigned URL with 0 Supabase storage egress", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "r2-live-account");
    vi.stubEnv("R2_ACCESS_KEY_ID", "r2-live-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "r2-live-secret");
    vi.stubEnv("R2_BUCKET_NAME", "production-releases");

    // Mock R2 HEAD presence check returning 200 OK
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    setupValidDownloadRow("books/mastering-scale.pdf");

    const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") || "";

    // 1. Must redirect to Cloudflare R2 S3 API host
    expect(location).toContain("https://r2-live-account.r2.cloudflarestorage.com/production-releases/books/mastering-scale.pdf");
    expect(location).toContain("X-Amz-Signature=");

    // 2. Supabase Storage must NOT be hit (0 bytes transferred from Supabase storage)
    expect(createSignedUrlMock).not.toHaveBeenCalled();

    // 3. Download completion event recorded with token hash (raw token never logged)
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sale_id: "sale-xyz-123",
        product_id: "prod-abc-456",
        event_type: "download_completed",
        token_hash: tokenHash(validToken),
      }),
    );
    expect(JSON.stringify(insertMock.mock.calls)).not.toContain(validToken);

    // 4. Verification HEAD request was properly bounded
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://r2-live-account.r2.cloudflarestorage.com/production-releases/books/mastering-scale.pdf"),
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("CASE 2 (Object Fallback): R2 configured but object is 404 in R2 -> falls back to Supabase Storage seamlessly", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "r2-live-account");
    vi.stubEnv("R2_ACCESS_KEY_ID", "r2-live-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "r2-live-secret");
    vi.stubEnv("R2_BUCKET_NAME", "production-releases");

    // Mock R2 HEAD check returning 404 NOT FOUND (object not yet synced to R2)
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));

    // Mock Supabase Storage signing succeeding
    createSignedUrlMock.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.co/storage/v1/object/sign/release-files/books/unsynced.pdf?token=sb-tok" },
      error: null,
    });

    setupValidDownloadRow("books/unsynced.pdf");

    const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

    // Buyer must NOT receive a 404! Seamless 302 redirect to Supabase fallback
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://supabase.co/storage/v1/object/sign/release-files/books/unsynced.pdf?token=sb-tok");
    expect(createSignedUrlMock).toHaveBeenCalledWith("books/unsynced.pdf", expect.any(Number));
    expect(insertMock).toHaveBeenCalled();
  });

  it("CASE 3 (Network Resiliency): R2 HEAD check throws network error -> falls back to Supabase Storage", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "r2-live-account");
    vi.stubEnv("R2_ACCESS_KEY_ID", "r2-live-key");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "r2-live-secret");
    vi.stubEnv("R2_BUCKET_NAME", "production-releases");

    // Mock R2 network failure (e.g. DNS timeout, connection reset)
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network connection reset"));

    createSignedUrlMock.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.co/storage/v1/object/sign/release-files/books/network-fallback.pdf?token=sb-tok" },
      error: null,
    });

    setupValidDownloadRow("books/network-fallback.pdf");

    const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://supabase.co/storage/v1/object/sign/release-files/books/network-fallback.pdf?token=sb-tok");
    expect(createSignedUrlMock).toHaveBeenCalledWith("books/network-fallback.pdf", expect.any(Number));
  });

  it("CASE 4 (Zero Configuration): R2 env vars missing -> transparently uses Supabase Storage default", async () => {
    // No R2 env vars set
    createSignedUrlMock.mockResolvedValueOnce({
      data: { signedUrl: "https://supabase.co/storage/v1/object/sign/release-files/books/standard.pdf?token=sb-tok" },
      error: null,
    });

    setupValidDownloadRow("books/standard.pdf");

    const req = new NextRequest(`https://expanpress.com/d/${validToken}`);
    const res = await GET(req, { params: Promise.resolve({ token: validToken }) });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://supabase.co/storage/v1/object/sign/release-files/books/standard.pdf?token=sb-tok");
    expect(createSignedUrlMock).toHaveBeenCalledWith("books/standard.pdf", expect.any(Number));
  });
});
