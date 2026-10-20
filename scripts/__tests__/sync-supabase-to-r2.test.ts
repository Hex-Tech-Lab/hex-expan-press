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

    it("returns undefined when --prefix has no trailing value", () => {
      expect(parsePrefixArg(["node", "sync.ts", "--prefix"])).toBeUndefined();
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
    it("skips files already present in Cloudflare R2", async () => {
      const harness = makeSyncTestHarness({
        files: [{ name: "book.pdf", id: "id1", metadata: { mimetype: "application/pdf" } }],
      });

      const result = await syncSupabaseToR2({
        supabaseClient: harness.fakeClient as never,
        fetchImpl: harness.fetchImpl as never,
        logger: harness.testLogger,
      });

      expect(result.totalFound).toBe(1);
      expect(result.alreadySynced).toBe(1);
      expect(result.uploaded).toBe(0);
      expect(harness.downloadMock).not.toHaveBeenCalled();
    });

    it("downloads and uploads missing files to R2, then verifies with HEAD", async () => {
      // 1st fetch (HEAD): 404 (missing in R2)
      // 2nd fetch (PUT): 200 (uploaded to R2)
      // 3rd fetch (HEAD): 200 (verified post-upload)
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const dummyBlob = new Blob(["test-pdf-bytes"], { type: "application/pdf" });
      const harness = makeSyncTestHarness({
        files: [{ name: "books/missing.pdf", id: "id2", metadata: { mimetype: "application/pdf" } }],
        downloadBlob: dummyBlob,
        fetchImpl: fetchImpl as never,
      });

      const result = await syncSupabaseToR2({
        supabaseClient: harness.fakeClient as never,
        fetchImpl: harness.fetchImpl as never,
        logger: harness.testLogger,
      });

      expect(result.totalFound).toBe(1);
      expect(result.alreadySynced).toBe(0);
      expect(result.uploaded).toBe(1);
      expect(result.verified).toBe(1);
      expect(result.failed).toBe(0);

      expect(harness.downloadMock).toHaveBeenCalledWith("books/missing.pdf");
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it("respects dryRun mode without calling download or upload", async () => {
      const harness = makeSyncTestHarness({
        files: [{ name: "new-file.pdf", id: "id3", metadata: {} }],
        fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 404 })) as never,
      });

      const result = await syncSupabaseToR2({
        supabaseClient: harness.fakeClient as never,
        fetchImpl: harness.fetchImpl as never,
        dryRun: true,
        logger: harness.testLogger,
      });

      expect(result.totalFound).toBe(1);
      expect(result.alreadySynced).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.uploaded).toBe(0);
      expect(harness.downloadMock).not.toHaveBeenCalled();
    });

    it("handles R2 HEAD network/auth errors gracefully without downloading or uploading", async () => {
      const harness = makeSyncTestHarness({
        files: [{ name: "error-file.pdf", id: "id4", metadata: {} }],
        fetchImpl: vi.fn().mockRejectedValue(new Error("Connection refused")) as never,
      });

      const result = await syncSupabaseToR2({
        supabaseClient: harness.fakeClient as never,
        fetchImpl: harness.fetchImpl as never,
        logger: harness.testLogger,
      });

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
