import { describe, it, expect, vi, beforeEach } from "vitest";
import { listAllSupabaseFiles, syncSupabaseToR2 } from "../sync-supabase-to-r2";

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
    for (const [k, v] of Object.entries(dummyR2Env)) {
      vi.stubEnv(k, v);
    }
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
  });

  describe("syncSupabaseToR2", () => {
    it("skips files already present in Cloudflare R2", async () => {
      const listMock = vi.fn().mockResolvedValue({
        data: [{ name: "book.pdf", id: "id1", metadata: { mimetype: "application/pdf" } }],
        error: null,
      });
      const downloadMock = vi.fn();
      const fakeClient = {
        storage: {
          from: vi.fn(() => ({
            list: listMock,
            download: downloadMock,
          })),
        },
      };

      // R2 HEAD returns 200 (already exists)
      const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      const logs: string[] = [];
      const testLogger = {
        log: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
      };

      const result = await syncSupabaseToR2({
        supabaseClient: fakeClient as never,
        fetchImpl: fetchImpl as never,
        logger: testLogger,
      });

      expect(result.totalFound).toBe(1);
      expect(result.alreadySynced).toBe(1);
      expect(result.uploaded).toBe(0);
      expect(downloadMock).not.toHaveBeenCalled();
    });

    it("downloads and uploads missing files to R2, then verifies with HEAD", async () => {
      const listMock = vi.fn().mockResolvedValue({
        data: [{ name: "books/missing.pdf", id: "id2", metadata: { mimetype: "application/pdf" } }],
        error: null,
      });
      const dummyBlob = new Blob(["test-pdf-bytes"], { type: "application/pdf" });
      const downloadMock = vi.fn().mockResolvedValue({
        data: dummyBlob,
        error: null,
      });

      const fakeClient = {
        storage: {
          from: vi.fn(() => ({
            list: listMock,
            download: downloadMock,
          })),
        },
      };

      // 1st fetch (HEAD): 404 (missing in R2)
      // 2nd fetch (PUT): 200 (uploaded to R2)
      // 3rd fetch (HEAD): 200 (verified post-upload)
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const logs: string[] = [];
      const testLogger = {
        log: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
      };

      const result = await syncSupabaseToR2({
        supabaseClient: fakeClient as never,
        fetchImpl: fetchImpl as never,
        logger: testLogger,
      });

      expect(result.totalFound).toBe(1);
      expect(result.alreadySynced).toBe(0);
      expect(result.uploaded).toBe(1);
      expect(result.verified).toBe(1);
      expect(result.failed).toBe(0);

      expect(downloadMock).toHaveBeenCalledWith("books/missing.pdf");
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it("respects dryRun mode without calling download or upload", async () => {
      const listMock = vi.fn().mockResolvedValue({
        data: [{ name: "new-file.pdf", id: "id3", metadata: {} }],
        error: null,
      });
      const downloadMock = vi.fn();
      const fakeClient = {
        storage: {
          from: vi.fn(() => ({
            list: listMock,
            download: downloadMock,
          })),
        },
      };

      // R2 HEAD: 404 (missing)
      const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

      const result = await syncSupabaseToR2({
        supabaseClient: fakeClient as never,
        fetchImpl: fetchImpl as never,
        dryRun: true,
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(result.totalFound).toBe(1);
      expect(result.alreadySynced).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.uploaded).toBe(0);
      expect(downloadMock).not.toHaveBeenCalled();
    });

    it("handles R2 HEAD network/auth errors gracefully without downloading or uploading", async () => {
      const listMock = vi.fn().mockResolvedValue({
        data: [{ name: "error-file.pdf", id: "id4", metadata: {} }],
        error: null,
      });
      const downloadMock = vi.fn();
      const fakeClient = {
        storage: {
          from: vi.fn(() => ({
            list: listMock,
            download: downloadMock,
          })),
        },
      };

      // R2 HEAD throws network error
      const fetchImpl = vi.fn().mockRejectedValue(new Error("Connection refused"));

      const logs: string[] = [];
      const testLogger = {
        log: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
      };

      const result = await syncSupabaseToR2({
        supabaseClient: fakeClient as never,
        fetchImpl: fetchImpl as never,
        logger: testLogger,
      });

      expect(result.totalFound).toBe(1);
      expect(result.alreadySynced).toBe(0);
      expect(result.uploaded).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors).toEqual([
        { path: "error-file.pdf", error: "R2 HEAD check failed: Connection refused" },
      ]);
      expect(downloadMock).not.toHaveBeenCalled();
    });
  });
});

