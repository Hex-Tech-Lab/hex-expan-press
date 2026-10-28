import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listAllSupabaseFiles,
  syncSupabaseToR2,
  parsePrefixArg,
} from "../sync-supabase-to-r2";

interface HarnessOptions {
  files?: Array<{ name: string; id?: string | null; metadata?: Record<string, unknown> }>;
  downloadBlob?: Blob | null;
  downloadError?: { message: string } | null;
  fetchImpl?: typeof fetch;
}

function makeSyncTestHarness(opts: HarnessOptions = {}) {
  const logs: string[] = [];
  const testLogger = {
    log: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };

  const listMock = vi.fn().mockResolvedValue({
    data: opts.files ?? [],
    error: null,
  });

  const downloadMock = vi.fn().mockResolvedValue({
    data: opts.downloadBlob ?? null,
    error: opts.downloadError ?? null,
  });

  const fakeClient = {
    storage: {
      from: vi.fn(() => ({
        list: listMock,
        download: downloadMock,
      })),
    },
  };

  const fetchImpl =
    opts.fetchImpl ?? vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

  return {
    fakeClient,
    listMock,
    downloadMock,
    fetchImpl,
    testLogger,
    logs,
  };
}

describe("sync-supabase-to-r2", () => {
  const dummyR2Env = {
    R2_ACCOUNT_ID: "acc-123",
    R2_ACCESS_KEY_ID: "key-123",
    R2_SECRET_ACCESS_KEY: "secret-123",
    R2_BUCKET_NAME: "r2-bucket",
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.CLOUDFLARE_R2_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
    delete process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
    delete process.env.CLOUDFLARE_R2_BUCKET;
    delete process.env.CLOUDFLARE_R2_BUCKET_NAME;
    for (const [k, v] of Object.entries(dummyR2Env)) {
      vi.stubEnv(k, v);
    }
  });

  describe("parsePrefixArg", () => {
    it("parses --prefix <val> syntax", () => {
      expect(parsePrefixArg(["node", "sync.ts", "--prefix", "releases/v1"])).toBe("releases/v1");
    });

    it("parses --prefix=<val> syntax", () => {
      expect(parsePrefixArg(["node", "sync.ts", "--prefix=releases/v2"])).toBe("releases/v2");
    });

    it("returns undefined when --prefix is not present", () => {
      expect(parsePrefixArg(["node", "sync.ts", "--dry-run"])).toBeUndefined();
    });

    it("returns undefined for an empty argv with no prefix flag", () => {
      expect(parsePrefixArg(["node", "sync.ts"])).toBeUndefined();
    });

    it("does not consume the next flag when --prefix is followed by --dry-run", () => {
      // Must throw rather than return "--dry-run" as the prefix value.
      expect(() => parsePrefixArg(["node", "sync.ts", "--prefix", "--dry-run"])).toThrow(
        /followed by the flag --dry-run/,
      );
    });

    it("rejects --prefix at the end of argv instead of treating it as the bucket root", () => {
      expect(() => parsePrefixArg(["node", "sync.ts", "--prefix"])).toThrow(/has no value/);
    });

    it("rejects an empty --prefix= value instead of returning an empty string", () => {
      expect(() => parsePrefixArg(["node", "sync.ts", "--prefix="])).toThrow(/empty value/);
    });

    it("rejects an empty separate --prefix value", () => {
      expect(() => parsePrefixArg(["node", "sync.ts", "--prefix", ""])).toThrow(/has no value/);
    });
  });

  describe("listAllSupabaseFiles", () => {
    it("lists files recursively, traversing folders when item.id is null", async () => {
      const listMock = vi.fn((prefix: string) => {
        if (prefix === "") {
          return Promise.resolve({
            data: [
              { name: "root.pdf", id: "f-root", metadata: { mimetype: "application/pdf", size: 100 } },
              { name: "books", id: null, metadata: {} }, // folder
            ],
            error: null,
          });
        }
        if (prefix === "books") {
          return Promise.resolve({
            data: [
              { name: "playbook.pdf", id: "f-playbook", metadata: { mimetype: "application/pdf", size: 200 } },
              { name: "guide.epub", id: "f-guide", metadata: { mimetype: "application/epub+zip", size: 300 } },
            ],
            error: null,
          });
        }
        return Promise.resolve({ data: [], error: null });
      });

      const fakeClient = {
        storage: {
          from: vi.fn(() => ({ list: listMock })),
        },
      };

      const files = await listAllSupabaseFiles(fakeClient as never, "release-files");
      expect(files).toEqual([
        { path: "root.pdf", mimetype: "application/pdf", size: 100 },
        { path: "books/playbook.pdf", mimetype: "application/pdf", size: 200 },
        { path: "books/guide.epub", mimetype: "application/epub+zip", size: 300 },
      ]);
    });

    it("throws an informative error if listing fails", async () => {
      const fakeClient = {
        storage: {
          from: vi.fn(() => ({
            list: vi.fn().mockResolvedValue({ data: null, error: { message: "Bucket not found" } }),
          })),
        },
      };

      await expect(listAllSupabaseFiles(fakeClient as never, "bad-bucket")).rejects.toThrow(
        "Failed to list files from Supabase Storage bucket [bad-bucket]",
      );
    });

    it("paginates across multiple pages when a folder contains more than 1,000 items", async () => {
      const page1Items = Array.from({ length: 1000 }, (_, i) => ({
        name: `file-${i.toString().padStart(4, "0")}.pdf`,
        id: `id-${i}`,
        metadata: { mimetype: "application/pdf", size: 1000 + i },
      }));
      const page2Items = [
        { name: "subfolder", id: null, metadata: {} },
        ...Array.from({ length: 499 }, (_, i) => ({
          name: `file-${(1000 + i).toString().padStart(4, "0")}.pdf`,
          id: `id-${1000 + i}`,
          metadata: { mimetype: "application/pdf", size: 2000 + i },
        })),
      ];
      const subfolderItems = [
        { name: "nested.pdf", id: "id-nested", metadata: { mimetype: "application/pdf", size: 500 } },
      ];

      const listMock = vi.fn((prefix: string, options?: { offset?: number; limit?: number }) => {
        if (prefix === "") {
          if (options?.offset === 0) {
            return Promise.resolve({ data: page1Items, error: null });
          }
          if (options?.offset === 1000) {
            return Promise.resolve({ data: page2Items, error: null });
          }
        }
        if (prefix === "subfolder") {
          return Promise.resolve({ data: subfolderItems, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });

      const fakeClient = {
        storage: {
          from: vi.fn(() => ({ list: listMock })),
        },
      };

      const files = await listAllSupabaseFiles(fakeClient as never, "release-files");
      expect(files.length).toBe(1500);
      expect(files[0].path).toBe("file-0000.pdf");
      expect(files[999].path).toBe("file-0999.pdf");
      expect(files[1000].path).toBe("subfolder/nested.pdf");
      expect(files[1001].path).toBe("file-1000.pdf");
      expect(listMock).toHaveBeenCalledWith("", expect.objectContaining({ limit: 1000, offset: 0 }));
      expect(listMock).toHaveBeenCalledWith("", expect.objectContaining({ limit: 1000, offset: 1000 }));
      expect(listMock).toHaveBeenCalledWith("subfolder", expect.objectContaining({ limit: 1000, offset: 0 }));
    });
  });

  describe("syncSupabaseToR2", () => {
    // Freshness contract: a copy is current only when R2 holds the same source ETag that Supabase
    // lists. Presence alone proves nothing (ADR 0063).
    const SRC_ETAG = '"src-v1"';
    const SOURCE_HDR = "x-amz-meta-supabase-etag";
    const syncFile = (name: string, id = "id") => ({
      name,
      id,
      metadata: { mimetype: "application/pdf", eTag: SRC_ETAG },
    });
    const r2Head = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });
    const runSync = (harness: ReturnType<typeof makeSyncTestHarness>, extra: Record<string, unknown> = {}) =>
      syncSupabaseToR2({
        supabaseClient: harness.fakeClient as never,
        fetchImpl: harness.fetchImpl as never,
        logger: harness.testLogger,
        ...extra,
      });

    it("skips a copy whose source ETag matches, without downloading or writing", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(r2Head(200, { etag: '"r2-1"', [SOURCE_HDR]: SRC_ETAG }));
      const harness = makeSyncTestHarness({ files: [syncFile("book.pdf")], fetchImpl: fetchImpl as never });

      const result = await runSync(harness);

      expect(result.totalFound).toBe(1);
      expect(result.alreadySynced).toBe(1);
      expect(result.uploaded).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(harness.downloadMock).not.toHaveBeenCalled();
    });

    it("refreshes a stale copy with If-Match on its R2 ETag, even when the size is unchanged", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(r2Head(200, { etag: '"r2-old"', [SOURCE_HDR]: '"src-v0"' }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(r2Head(200, { etag: '"r2-new"', [SOURCE_HDR]: SRC_ETAG }));
      const harness = makeSyncTestHarness({
        files: [syncFile("book.pdf")],
        downloadBlob: new Blob(["same-size-bytes"]),
        fetchImpl: fetchImpl as never,
      });

      const result = await runSync(harness);

      expect(result).toMatchObject({ alreadySynced: 0, uploaded: 1, verified: 1, failed: 0 });
      const putInit = fetchImpl.mock.calls[1][1] as RequestInit;
      const putHeaders = putInit.headers as Record<string, string>;
      expect(putHeaders["if-match"]).toBe('"r2-old"');
      expect(putHeaders["if-none-match"]).toBeUndefined();
      expect(putHeaders[SOURCE_HDR]).toBe(SRC_ETAG);
      expect(decodeURIComponent(String(fetchImpl.mock.calls[1][0]))).toContain(
        "X-Amz-SignedHeaders=host;if-match;x-amz-meta-supabase-etag",
      );
    });

    it("creates an absent object only if none exists (If-None-Match: *)", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(r2Head(404))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(r2Head(200, { etag: '"r2-1"', [SOURCE_HDR]: SRC_ETAG }));
      const harness = makeSyncTestHarness({
        files: [syncFile("books/new.pdf")],
        downloadBlob: new Blob(["bytes"]),
        fetchImpl: fetchImpl as never,
      });

      const result = await runSync(harness);

      expect(result).toMatchObject({ uploaded: 1, verified: 1, failed: 0 });
      expect(harness.downloadMock).toHaveBeenCalledWith("books/new.pdf");
      const putHeaders = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
      expect(putHeaders["if-none-match"]).toBe("*");
      expect(putHeaders["if-match"]).toBeUndefined();
    });

    it("refreshes an unversioned copy that has no source ETag recorded", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(r2Head(200, { etag: '"r2-legacy"' }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(r2Head(200, { etag: '"r2-new"', [SOURCE_HDR]: SRC_ETAG }));
      const harness = makeSyncTestHarness({
        files: [syncFile("legacy.pdf")],
        downloadBlob: new Blob(["bytes"]),
        fetchImpl: fetchImpl as never,
      });

      const result = await runSync(harness);

      expect(result).toMatchObject({ alreadySynced: 0, uploaded: 1, verified: 1, failed: 0 });
      const putHeaders = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
      expect(putHeaders["if-match"]).toBe('"r2-legacy"');
    });

    it("counts a successful write whose source ETag fails verification as uploaded but not verified", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(r2Head(404))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(r2Head(200, { etag: '"r2-1"', [SOURCE_HDR]: '"src-v0"' }));
      const harness = makeSyncTestHarness({
        files: [syncFile("book.pdf")],
        downloadBlob: new Blob(["bytes"]),
        fetchImpl: fetchImpl as never,
      });

      const result = await runSync(harness);

      expect(result).toMatchObject({ uploaded: 1, verified: 0, failed: 1 });
      expect(result.errors).toEqual([
        { path: "book.pdf", error: "Post-upload source ETag verification failed" },
      ]);
    });

    it("reports a 412 as a failed concurrent write and does not overwrite or retry", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(r2Head(200, { etag: '"r2-old"', [SOURCE_HDR]: '"src-v0"' }))
        .mockResolvedValueOnce(new Response(null, { status: 412 }));
      const harness = makeSyncTestHarness({
        files: [syncFile("book.pdf")],
        downloadBlob: new Blob(["bytes"]),
        fetchImpl: fetchImpl as never,
      });

      const result = await runSync(harness);

      expect(result).toMatchObject({ uploaded: 0, verified: 0, failed: 1 });
      expect(result.errors[0].error).toContain("precondition failed");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("refuses to sync a listed object that has no ETag, without contacting R2", async () => {
      const fetchImpl = vi.fn();
      const harness = makeSyncTestHarness({
        files: [{ name: "x.pdf", id: "id", metadata: { mimetype: "application/pdf" } }],
        fetchImpl: fetchImpl as never,
      });

      const result = await runSync(harness);

      expect(result).toMatchObject({ uploaded: 0, failed: 1 });
      expect(result.errors).toEqual([{ path: "x.pdf", error: "Supabase listing returned no ETag" }]);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("refuses an overwrite when R2 returns a copy without an ETag to condition on", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(r2Head(200, { [SOURCE_HDR]: '"src-v0"' }));
      const harness = makeSyncTestHarness({
        files: [syncFile("book.pdf")],
        downloadBlob: new Blob(["bytes"]),
        fetchImpl: fetchImpl as never,
      });

      const result = await runSync(harness);

      expect(result).toMatchObject({ uploaded: 0, failed: 1 });
      expect(result.errors).toEqual([
        { path: "book.pdf", error: "R2 returned no ETag; overwrite not conditioned" },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("respects dryRun mode without calling download or upload", async () => {
      const harness = makeSyncTestHarness({
        files: [syncFile("new-file.pdf")],
        fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 404 })) as never,
      });

      const result = await runSync(harness, { dryRun: true });

      expect(result.totalFound).toBe(1);
      expect(result.alreadySynced).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.uploaded).toBe(0);
      expect(harness.downloadMock).not.toHaveBeenCalled();
    });

    it("handles R2 HEAD network/auth errors gracefully without downloading or uploading", async () => {
      const harness = makeSyncTestHarness({
        files: [syncFile("error-file.pdf")],
        fetchImpl: vi.fn().mockRejectedValue(new Error("Connection refused")) as never,
      });

      const result = await runSync(harness);

      expect(result.totalFound).toBe(1);
      expect(result.alreadySynced).toBe(0);
      expect(result.uploaded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors).toEqual([
        { path: "error-file.pdf", error: "R2 HEAD check failed: Connection refused" },
      ]);
      expect(harness.downloadMock).not.toHaveBeenCalled();
    });

    it("throws when both SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEY are unset", async () => {
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
      vi.stubEnv("SUPABASE_SECRET_KEY", "");
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.SUPABASE_SECRET_KEY;

      const harness = makeSyncTestHarness();
      await expect(
        syncSupabaseToR2({
          supabaseClient: harness.fakeClient as never,
          fetchImpl: harness.fetchImpl as never,
          logger: harness.testLogger,
        }),
      ).rejects.toThrow(
        "Missing required Supabase environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY",
      );
    });

    it("falls back to SUPABASE_SECRET_KEY when SUPABASE_SERVICE_ROLE_KEY is unset", async () => {
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      vi.stubEnv("SUPABASE_SECRET_KEY", "test-fallback-secret-key");

      const harness = makeSyncTestHarness();
      const result = await syncSupabaseToR2({
        supabaseClient: harness.fakeClient as never,
        fetchImpl: harness.fetchImpl as never,
        logger: harness.testLogger,
      });

      expect(result.totalFound).toBe(0);
    });

    it("falls back to CLOUDFLARE_* aliases when R2_* are unset", async () => {
      vi.stubEnv("R2_ACCOUNT_ID", "");
      vi.stubEnv("R2_ACCESS_KEY_ID", "");
      vi.stubEnv("R2_SECRET_ACCESS_KEY", "");
      vi.stubEnv("R2_BUCKET_NAME", "");
      delete process.env.R2_ACCOUNT_ID;
      delete process.env.R2_ACCESS_KEY_ID;
      delete process.env.R2_SECRET_ACCESS_KEY;
      delete process.env.R2_BUCKET_NAME;

      vi.stubEnv("CLOUDFLARE_R2_ACCOUNT_ID", "cf-acc-123");
      vi.stubEnv("CLOUDFLARE_R2_ACCESS_KEY_ID", "cf-key-123");
      vi.stubEnv("CLOUDFLARE_R2_SECRET_ACCESS_KEY", "cf-secret-123");
      vi.stubEnv("CLOUDFLARE_R2_BUCKET_NAME", "cf-r2-bucket");

      const harness = makeSyncTestHarness();
      const result = await syncSupabaseToR2({
        supabaseClient: harness.fakeClient as never,
        fetchImpl: harness.fetchImpl as never,
        logger: harness.testLogger,
      });

      expect(result.totalFound).toBe(0);
    });

    it("passes prefix filter down to storage listing", async () => {
      const harness = makeSyncTestHarness();
      await syncSupabaseToR2({
        supabaseClient: harness.fakeClient as never,
        fetchImpl: harness.fetchImpl as never,
        logger: harness.testLogger,
        prefix: "releases/2026",
      });

      expect(harness.listMock).toHaveBeenCalledWith("releases/2026", expect.any(Object));
    });
  });
});
