import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateR2PresignedUrl,
  deriveSigningKey,
  buildCanonicalRequest,
  headR2Object,
  putR2Object,
  R2StorageAdapter,
  SupabaseStorageAdapter,
  getDeliveryStorageAdapter,
} from "../r2.adapter";

describe("generateR2PresignedUrl (AWS SigV4 for Cloudflare R2)", () => {
  const fixedDate = new Date("2026-10-19T12:00:00Z");

  it("generates a well-formed AWS SigV4 presigned GET URL matching known-answer signature vector", () => {
    const urlStr = generateR2PresignedUrl({
      endpoint: "https://test-account.r2.cloudflarestorage.com",
      bucket: "release-files",
      key: "books/500k-playbook.pdf",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      region: "auto",
      expiresInSeconds: 300,
      date: fixedDate,
    });

    const parsed = new URL(urlStr);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.host).toBe("test-account.r2.cloudflarestorage.com");
    expect(parsed.pathname).toBe("/release-files/books/500k-playbook.pdf");

    const sp = parsed.searchParams;
    expect(sp.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(sp.get("X-Amz-Credential")).toBe("test-access-key/20261019/auto/s3/aws4_request");
    expect(sp.get("X-Amz-Date")).toBe("20261019T120000Z");
    expect(sp.get("X-Amz-Expires")).toBe("300");
    expect(sp.get("X-Amz-SignedHeaders")).toBe("host");
    // Known-answer SigV4 test vector assertion
    expect(sp.get("X-Amz-Signature")).toBe("c52c47a5bead5a4db56c970ed8d2bba535a1bb82e2a40a807de7d8ee385e9dd7");
  });

  it("normalizes leading slashes in object keys", () => {
    const urlStr = generateR2PresignedUrl({
      endpoint: "https://test-account.r2.cloudflarestorage.com",
      bucket: "release-files",
      key: "///books/deep/volume.pdf",
      accessKeyId: "key-1",
      secretAccessKey: "sec-1",
      date: fixedDate,
    });

    const parsed = new URL(urlStr);
    expect(parsed.pathname).toBe("/release-files/books/deep/volume.pdf");
  });

  it("ignores publicDomain and always uses S3 API endpoint host", () => {
    const urlStr = generateR2PresignedUrl({
      endpoint: "https://test-account.r2.cloudflarestorage.com",
      bucket: "release-files",
      key: "file.pdf",
      accessKeyId: "key-1",
      secretAccessKey: "sec-1",
      publicDomain: "download.expanpress.com",
      date: fixedDate,
    });

    const parsed = new URL(urlStr);
    expect(parsed.host).toBe("test-account.r2.cloudflarestorage.com");
    expect(parsed.pathname).toBe("/release-files/file.pdf");
  });

  it("generates deterministic signature for fixed inputs", () => {
    const opts = {
      endpoint: "https://acc1.r2.cloudflarestorage.com",
      bucket: "b1",
      key: "k1.pdf",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      date: fixedDate,
    };
    const url1 = generateR2PresignedUrl(opts);
    const url2 = generateR2PresignedUrl(opts);
    expect(url1).toBe(url2);
  });
});

describe("decomposed helpers", () => {
  it("deriveSigningKey derives deterministic buffer", () => {
    const k1 = deriveSigningKey("secret", "20261019", "auto");
    const k2 = deriveSigningKey("secret", "20261019", "auto");
    expect(Buffer.isBuffer(k1)).toBe(true);
    expect(k1.equals(k2)).toBe(true);
  });

  it("buildCanonicalRequest constructs correct canonical request and headers", () => {
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest(
      "GET",
      "/bucket/file.pdf",
      "X-Amz-Algorithm=AWS4-HMAC-SHA256",
      "acc.r2.cloudflarestorage.com",
    );
    expect(signedHeaders).toBe("host");
    expect(canonicalRequest).toContain("GET\n/bucket/file.pdf\nX-Amz-Algorithm=AWS4-HMAC-SHA256\nhost:acc.r2.cloudflarestorage.com\n");
  });

  it("headR2Object returns true on 200, false on 404, false on network error", async () => {
    const mock200 = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    expect(await headR2Object({
      endpoint: "https://acc.r2.cloudflarestorage.com",
      bucket: "b",
      key: "k",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      fetchImpl: mock200 as unknown as typeof fetch,
    })).toBe(true);

    const mock404 = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    expect(await headR2Object({
      endpoint: "https://acc.r2.cloudflarestorage.com",
      bucket: "b",
      key: "k",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      fetchImpl: mock404 as unknown as typeof fetch,
    })).toBe(false);

    const mockThrow = vi.fn().mockRejectedValue(new Error("network error"));
    expect(await headR2Object({
      endpoint: "https://acc.r2.cloudflarestorage.com",
      bucket: "b",
      key: "k",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      fetchImpl: mockThrow as unknown as typeof fetch,
    })).toBe(false);
  });
});

describe("R2StorageAdapter", () => {
  it("creates signed download URL using config when object exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const adapter = new R2StorageAdapter({
      accountId: "acc-123",
      accessKeyId: "ak-123",
      secretAccessKey: "sk-123",
      bucket: "books-bucket",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const url = await adapter.createSignedDownloadUrl("release.epub", 600);
    expect(url).not.toBeNull();
    expect(url).toContain("https://acc-123.r2.cloudflarestorage.com/books-bucket/release.epub");
    expect(url).toContain("X-Amz-Signature=");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://acc-123.r2.cloudflarestorage.com/books-bucket/release.epub"),
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("returns null when object does not exist in R2 (404)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const adapter = new R2StorageAdapter({
      accountId: "acc-123",
      accessKeyId: "ak-123",
      secretAccessKey: "sk-123",
      bucket: "books-bucket",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const url = await adapter.createSignedDownloadUrl("missing.epub", 600);
    expect(url).toBeNull();
  });

  it("returns null if generation throws on invalid endpoint", async () => {
    const adapter = new R2StorageAdapter({
      accountId: "acc-123",
      accessKeyId: "ak-123",
      secretAccessKey: "sk-123",
      bucket: "books-bucket",
      endpoint: "not-a-valid-url",
    });

    const url = await adapter.createSignedDownloadUrl("release.epub", 600);
    expect(url).toBeNull();
  });
});

describe("SupabaseStorageAdapter", () => {
  it("delegates to sbAdmin.storage.from(bucket).createSignedUrl", async () => {
    const createSignedUrlMock = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://supabase.co/storage/v1/object/sign/file.pdf?token=abc" },
      error: null,
    });
    const fakeSb = {
      storage: {
        from: vi.fn(() => ({ createSignedUrl: createSignedUrlMock })),
      },
    };

    const adapter = new SupabaseStorageAdapter(fakeSb as never, "release-files");
    const result = await adapter.createSignedDownloadUrl("file.pdf", 300);

    expect(fakeSb.storage.from).toHaveBeenCalledWith("release-files");
    expect(createSignedUrlMock).toHaveBeenCalledWith("file.pdf", 300);
    expect(result).toBe("https://supabase.co/storage/v1/object/sign/file.pdf?token=abc");
  });

  it("returns null on storage error", async () => {
    const createSignedUrlMock = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "Object not found" },
    });
    const fakeSb = {
      storage: {
        from: vi.fn(() => ({ createSignedUrl: createSignedUrlMock })),
      },
    };

    const adapter = new SupabaseStorageAdapter(fakeSb as never, "release-files");
    const result = await adapter.createSignedDownloadUrl("missing.pdf", 300);
    expect(result).toBeNull();
  });
});

describe("getDeliveryStorageAdapter (fallback & preference)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("falls back to Supabase Storage when R2 env vars are unset", async () => {
    const createSignedUrlMock = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://supabase.example/signed/book.pdf" },
      error: null,
    });
    const fakeSb = {
      storage: {
        from: vi.fn(() => ({ createSignedUrl: createSignedUrlMock })),
      },
    };

    const adapter = getDeliveryStorageAdapter(fakeSb as never, "release-files");
    const url = await adapter.createSignedDownloadUrl("book.pdf", 300);

    expect(url).toBe("https://supabase.example/signed/book.pdf");
    expect(fakeSb.storage.from).toHaveBeenCalledWith("release-files");
  });

  it("falls back to Supabase Storage when R2_BUCKET_NAME is missing (does not fall back to Supabase bucket)", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "cf-acc-456");
    vi.stubEnv("R2_ACCESS_KEY_ID", "cf-key-456");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "cf-secret-456");
    // R2_BUCKET_NAME is unset

    const createSignedUrlMock = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://supabase.example/signed/fallback-sb.pdf" },
      error: null,
    });
    const fakeSb = {
      storage: {
        from: vi.fn(() => ({ createSignedUrl: createSignedUrlMock })),
      },
    };

    const adapter = getDeliveryStorageAdapter(fakeSb as never, "supabase-delivery-bucket");
    const url = await adapter.createSignedDownloadUrl("fallback-sb.pdf", 300);

    expect(url).toBe("https://supabase.example/signed/fallback-sb.pdf");
    expect(fakeSb.storage.from).toHaveBeenCalledWith("supabase-delivery-bucket");
  });

  it("uses Cloudflare R2 when R2 env vars are present and object exists (0% egress)", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "cf-acc-456");
    vi.stubEnv("R2_ACCESS_KEY_ID", "cf-key-456");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "cf-secret-456");
    vi.stubEnv("R2_BUCKET_NAME", "r2-releases");
    vi.stubEnv("R2_ENDPOINT", "https://cf-acc-456.r2.cloudflarestorage.com");
    vi.stubEnv("R2_REGION", "auto");
    vi.stubEnv("R2_PUBLIC_URL", "https://custom.expanpress.com");
    vi.stubEnv("R2_CUSTOM_DOMAIN", "custom.expanpress.com");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const createSignedUrlMock = vi.fn();
    const fakeSb = {
      storage: {
        from: vi.fn(() => ({ createSignedUrl: createSignedUrlMock })),
      },
    };

    const adapter = getDeliveryStorageAdapter(fakeSb as never);
    const url = await adapter.createSignedDownloadUrl("folder/book.pdf", 300);

    expect(url).not.toBeNull();
    expect(url).toContain("https://cf-acc-456.r2.cloudflarestorage.com/r2-releases/folder/book.pdf");
    expect(url).toContain("X-Amz-Signature=");
    // Custom domain ignored: host is S3 API endpoint
    expect(url).not.toContain("custom.expanpress.com");
    // Supabase Storage was NOT called! Zero egress fees.
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://cf-acc-456.r2.cloudflarestorage.com/r2-releases/folder/book.pdf"),
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("falls back to Supabase Storage when object is missing in R2 (404)", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "cf-acc-456");
    vi.stubEnv("R2_ACCESS_KEY_ID", "cf-key-456");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "cf-secret-456");
    vi.stubEnv("R2_BUCKET_NAME", "r2-releases");
    vi.stubEnv("R2_ENDPOINT", "https://cf-acc-456.r2.cloudflarestorage.com");
    vi.stubEnv("R2_REGION", "auto");
    vi.stubEnv("R2_PUBLIC_URL", "https://custom.expanpress.com");
    vi.stubEnv("R2_CUSTOM_DOMAIN", "custom.expanpress.com");

    // Object is missing in R2
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));

    const createSignedUrlMock = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://supabase.example/signed/fallback-from-r2.pdf" },
      error: null,
    });
    const fakeSb = {
      storage: {
        from: vi.fn(() => ({ createSignedUrl: createSignedUrlMock })),
      },
    };

    const adapter = getDeliveryStorageAdapter(fakeSb as never, "supabase-delivery-bucket");
    const url = await adapter.createSignedDownloadUrl("folder/missing.pdf", 300);

    expect(url).toBe("https://supabase.example/signed/fallback-from-r2.pdf");
    expect(fakeSb.storage.from).toHaveBeenCalledWith("supabase-delivery-bucket");
    expect(createSignedUrlMock).toHaveBeenCalledWith("folder/missing.pdf", 300);
  });
});

describe("putR2Object & R2StorageAdapter upload/has", () => {
  it("successfully uploads buffer to R2 and returns true", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const success = await putR2Object({
      endpoint: "https://acc1.r2.cloudflarestorage.com",
      bucket: "releases",
      key: "books/test.pdf",
      accessKeyId: "key1",
      secretAccessKey: "sec1",
      body: Buffer.from("pdf-content"),
      contentType: "application/pdf",
      fetchImpl: fetchSpy as never,
    });

    expect(success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://acc1.r2.cloudflarestorage.com/releases/books/test.pdf"),
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
      }),
    );
  });

  it("returns false when PUT fails with non-2xx status", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("AccessDenied", { status: 403 }));
    const success = await putR2Object({
      endpoint: "https://acc1.r2.cloudflarestorage.com",
      bucket: "releases",
      key: "books/test.pdf",
      accessKeyId: "key1",
      secretAccessKey: "sec1",
      body: Buffer.from("pdf-content"),
      fetchImpl: fetchSpy as never,
    });

    expect(success).toBe(false);
  });

  it("R2StorageAdapter hasObject and uploadObject delegate to helpers", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const adapter = new R2StorageAdapter({
      accountId: "acc1",
      accessKeyId: "k1",
      secretAccessKey: "s1",
      bucket: "b1",
      fetchImpl: fetchSpy as never,
    });

    const has = await adapter.hasObject("file.pdf");
    expect(has).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("file.pdf"),
      expect.objectContaining({ method: "HEAD" }),
    );

    const uploaded = await adapter.uploadObject("file.pdf", Buffer.from("hello"), "text/plain");
    expect(uploaded).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("file.pdf"),
      expect.objectContaining({ method: "PUT" }),
    );
  });
});

