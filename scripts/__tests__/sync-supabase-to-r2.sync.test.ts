import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncSupabaseToR2 } from "../sync-supabase-to-r2";
import { makeSyncTestHarness, resetSyncTestEnv } from "./sync-supabase-to-r2.harness";

describe("sync-supabase-to-r2: syncSupabaseToR2", () => {
  beforeEach(resetSyncTestEnv);

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
        sourceFetchImpl: harness.sourceFetch as never,
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
      expect(harness.sourceFetch).not.toHaveBeenCalled();
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
      // One source GET, and the body written to R2 is exactly the bytes that GET returned.
      expect(harness.sourceFetch).toHaveBeenCalledTimes(1);
      const putInit = fetchImpl.mock.calls[1][1] as RequestInit;
      expect(Buffer.from(putInit.body as Buffer).toString()).toBe("same-size-bytes");
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
        downloadBlob: new Blob(["bytes"]),
        fetchImpl: fetchImpl as never,
      });
      // Real listings return the folder, then its children by base name.
      harness.listMock
        .mockResolvedValueOnce({ data: [{ name: "books", id: null }], error: null })
        .mockResolvedValueOnce({ data: [syncFile("new.pdf")], error: null });

      const result = await runSync(harness);

      expect(result).toMatchObject({ uploaded: 1, verified: 1, failed: 0 });
      expect(String(harness.sourceFetch.mock.calls[0][0])).toMatch(/\/storage\/v1\/object\/release-files\/books\/new\.pdf$/);
      expect(harness.sourceFetch).toHaveBeenCalledTimes(1);
      expect(Buffer.from((fetchImpl.mock.calls[1][1] as RequestInit).body as Buffer).toString()).toBe("bytes");
      const putHeaders = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
      expect(putHeaders["if-none-match"]).toBe("*");
      expect(putHeaders["if-match"]).toBeUndefined();
      expect(putHeaders[SOURCE_HDR]).toBe(SRC_ETAG);
    });

    it("refuses to upload bytes when the served object's ETag differs from the listed one", async () => {
      // The listing saw v1. The GET serves v2 bytes with v2's ETag, so the served ETag does not match the listing.
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(r2Head(404))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      const harness = makeSyncTestHarness({
        files: [syncFile("book.pdf")],
        downloadBlob: new Blob(["v2-bytes"]),
        sourceEtag: '"src-v2"',
        fetchImpl: fetchImpl as never,
      });

      const result = await runSync(harness);

      expect(result).toMatchObject({ uploaded: 0, failed: 1 });
      expect(String(harness.sourceFetch.mock.calls[0][0])).toMatch(/\/book\.pdf$/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.errors).toEqual([
        { path: "book.pdf", error: "source changed between listing and download; re-run sync" },
      ]);
    });

    it("refuses to write bytes when the download carries no ETag", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(r2Head(404));
      const harness = makeSyncTestHarness({
        files: [syncFile("book.pdf")],
        downloadBlob: new Blob(["bytes"]),
        sourceEtag: "",
        fetchImpl: fetchImpl as never,
      });

      const result = await runSync(harness);

      expect(result).toMatchObject({ uploaded: 0, failed: 1 });
      expect(result.errors).toEqual([{ path: "book.pdf", error: "Supabase download returned no ETag" }]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
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
      expect(harness.sourceFetch).toHaveBeenCalledTimes(1);
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
      expect(harness.sourceFetch).toHaveBeenCalledTimes(1);
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

    it("bounds the source GET with an abort signal", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(r2Head(404));
      const harness = makeSyncTestHarness({ files: [syncFile("book.pdf")], downloadBlob: new Blob(["bytes"]), fetchImpl: fetchImpl as never });

      await runSync(harness);

      const init = harness.sourceFetch.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("refuses to write when the source GET returns a non-2xx status, without any R2 write", async () => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(r2Head(404));
      const harness = makeSyncTestHarness({ files: [syncFile("book.pdf")], fetchImpl: fetchImpl as never });
      harness.sourceFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

      const result = await runSync(harness);

      expect(result).toMatchObject({ uploaded: 0, failed: 1 });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toBe("book.pdf");
      expect(result.errors[0].error).toContain("HTTP 500");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
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
      expect(harness.sourceFetch).not.toHaveBeenCalled();
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
      expect(harness.sourceFetch).not.toHaveBeenCalled();
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

    it("rejects an empty programmatic prefix before any storage listing", async () => {
      const harness = makeSyncTestHarness({ files: [syncFile("book.pdf")] });

      await expect(runSync(harness, { prefix: "" })).rejects.toThrow(/Empty prefix/);
      expect(harness.fakeClient.storage.from).not.toHaveBeenCalled();
      expect(harness.listMock).not.toHaveBeenCalled();
    });

    it("isolates a thrown download error so the other files still upload", async () => {
      // Calls: a HEAD, a PUT, a verify | bad HEAD (download throws) | c HEAD, c PUT, c verify
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(r2Head(404))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(r2Head(200, { etag: '"r2-a"', [SOURCE_HDR]: SRC_ETAG }))
        .mockResolvedValueOnce(r2Head(404))
        .mockResolvedValueOnce(r2Head(404))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(r2Head(200, { etag: '"r2-c"', [SOURCE_HDR]: SRC_ETAG }));
      const harness = makeSyncTestHarness({
        files: [syncFile("a.pdf"), syncFile("bad.pdf"), syncFile("c.pdf")],
        downloadBlob: new Blob(["bytes"]),
        fetchImpl: fetchImpl as never,
      });
      harness.sourceFetch.mockImplementation(async (url: string) => {
        if (url.endsWith("/bad.pdf")) throw new Error("socket reset");
        return new Response(new Blob(["bytes"]), { status: 200, headers: { etag: SRC_ETAG } });
      });

      const result = await runSync(harness);

      expect(result).toMatchObject({ totalFound: 3, uploaded: 2, verified: 2, failed: 1 });
      expect(result.errors).toEqual([{ path: "bad.pdf", error: "Error: socket reset" }]);
      expect(fetchImpl).toHaveBeenCalledTimes(7);
    });

    it("records an HTTP 500 PUT for one file without counting it as uploaded, and keeps going", async () => {
      // Calls: a HEAD, a PUT, a verify | bad HEAD, bad PUT (500, no verify) | c HEAD, c PUT, c verify
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(r2Head(404))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(r2Head(200, { etag: '"r2-a"', [SOURCE_HDR]: SRC_ETAG }))
        .mockResolvedValueOnce(r2Head(404))
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(r2Head(404))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(r2Head(200, { etag: '"r2-c"', [SOURCE_HDR]: SRC_ETAG }));
      const harness = makeSyncTestHarness({
        files: [syncFile("a.pdf"), syncFile("bad.pdf"), syncFile("c.pdf")],
        downloadBlob: new Blob(["bytes"]),
        fetchImpl: fetchImpl as never,
      });

      const result = await runSync(harness);

      expect(result).toMatchObject({ totalFound: 3, uploaded: 2, verified: 2, failed: 1 });
      expect(result.errors).toEqual([
        { path: "bad.pdf", error: "R2 PUT request failed: PUT object returned status 500" },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(8);
    });

    it("counts a write as uploaded but not verified when the post-upload check throws, and keeps going", async () => {
      // Calls: book HEAD, book PUT, book verify (throws) | next HEAD, next PUT, next verify
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(r2Head(404))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockRejectedValueOnce(new Error("verify socket closed"))
        .mockResolvedValueOnce(r2Head(404))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(r2Head(200, { etag: '"r2-next"', [SOURCE_HDR]: SRC_ETAG }));
      const harness = makeSyncTestHarness({
        files: [syncFile("book.pdf"), syncFile("next.pdf")],
        downloadBlob: new Blob(["bytes"]),
        fetchImpl: fetchImpl as never,
      });

      const result = await runSync(harness);

      expect(result).toMatchObject({ totalFound: 2, uploaded: 2, verified: 1, failed: 1 });
      expect(result.errors).toEqual([
        { path: "book.pdf", error: "Post-upload verification failed: verify socket closed" },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(6);
    });
  });
});
