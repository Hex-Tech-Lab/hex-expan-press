import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateR2PresignedUrl,
  R2StorageAdapter,
  SupabaseStorageAdapter,
  getDeliveryStorageAdapter,
} from "../r2.adapter";

describe("generateR2PresignedUrl (AWS SigV4 for Cloudflare R2)", () => {
  const fixedDate = new Date("2026-10-19T12:00:00Z");

  it("generates a well-formed AWS SigV4 presigned GET URL", () => {
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
    expect(sp.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
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

  it("uses publicDomain override when specified", () => {
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
    expect(parsed.host).toBe("download.expanpress.com");
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

describe("R2StorageAdapter", () => {
  it("creates signed download URL using config", async () => {
    const adapter = new R2StorageAdapter({
      accountId: "acc-123",
      accessKeyId: "ak-123",
      secretAccessKey: "sk-123",
      bucket: "books-bucket",
    });

    const url = await adapter.createSignedDownloadUrl("release.epub", 600);
    expect(url).not.toBeNull();
    expect(url).toContain("https://acc-123.r2.cloudflarestorage.com/books-bucket/release.epub");
    expect(url).toContain("X-Amz-Signature=");
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
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
    delete process.env.R2_BUCKET_NAME;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("uses Cloudflare R2 when R2 env vars are present (0% egress)", async () => {
    process.env.R2_ACCOUNT_ID = "cf-acc-456";
    process.env.R2_ACCESS_KEY_ID = "cf-key-456";
    process.env.R2_SECRET_ACCESS_KEY = "cf-secret-456";
    process.env.R2_BUCKET_NAME = "r2-releases";

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
    // Supabase Storage was NOT called! Zero egress fees.
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });
});
