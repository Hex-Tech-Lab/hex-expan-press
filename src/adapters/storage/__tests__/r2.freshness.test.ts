import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildCanonicalRequest,
  getDeliveryStorageAdapter,
  putR2ObjectIf,
  R2StorageAdapter,
  resolveSupabaseSourceEtag,
  SOURCE_LISTING_TIMEOUT_MS,
  statR2Object,
} from "../r2.adapter";

const endpoint = "https://acc.r2.cloudflarestorage.com";
const creds = { accessKeyId: "ak", secretAccessKey: "sk" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("statR2Object", () => {
  it("returns R2's ETag and the stored source ETag on 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { etag: '"r2-1"', "x-amz-meta-supabase-etag": '"src-1"' } }),
    );

    const stat = await statR2Object({ endpoint, bucket: "b", key: "k", ...creds, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(stat).toEqual({ exists: true, etag: '"r2-1"', sourceEtag: '"src-1"' });
  });

  it("reports no source ETag for an object written before the freshness contract", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200, headers: { etag: '"r2-1"' } }));

    const stat = await statR2Object({ endpoint, bucket: "b", key: "k", ...creds, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(stat.exists).toBe(true);
    expect(stat.sourceEtag).toBeUndefined();
  });

  it("reports exists:false only on a confirmed 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    expect(await statR2Object({ endpoint, bucket: "b", key: "k", ...creds, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .toEqual({ exists: false });
  });

  it("throws on a server error instead of reporting absence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    await expect(
      statR2Object({ endpoint, bucket: "b", key: "k", ...creds, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow("HEAD object returned status 500");
  });
});

describe("putR2ObjectIf", () => {
  it("sends If-None-Match and the source ETag as signed headers, and reports written on 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const result = await putR2ObjectIf({
      endpoint,
      bucket: "b",
      key: "k",
      ...creds,
      body: "payload",
      ifNoneMatch: "*",
      metadata: { "supabase-etag": '"src-1"' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ status: "written" });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      "if-none-match": "*",
      "x-amz-meta-supabase-etag": '"src-1"',
    });
    expect(decodeURIComponent(String(fetchImpl.mock.calls[0][0]))).toContain(
      "X-Amz-SignedHeaders=host;if-none-match;x-amz-meta-supabase-etag",
    );
  });

  it("maps 412 to precondition_failed, not to a generic failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 412 }));

    const result = await putR2ObjectIf({
      endpoint, bucket: "b", key: "k", ...creds, body: "x", ifMatch: '"r2-old"', fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ status: "precondition_failed" });
  });

  it("maps other statuses to failed with the status in the reason", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    const result = await putR2ObjectIf({
      endpoint, bucket: "b", key: "k", ...creds, body: "x", fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ status: "failed", reason: "PUT object returned status 500" });
  });

  it("maps a network error to failed, with the message", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket hang up"));

    const result = await putR2ObjectIf({
      endpoint, bucket: "b", key: "k", ...creds, body: "x", fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ status: "failed", reason: "socket hang up" });
  });

  it("rejects an insecure http endpoint before sending any request", async () => {
    vi.stubEnv("R2_ALLOW_INSECURE_HTTP", "");
    const fetchImpl = vi.fn();

    await expect(
      putR2ObjectIf({
        endpoint: "http://acc.example.test", bucket: "b", key: "k", ...creds, body: "x", fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Insecure HTTP endpoint rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns failed for a malformed endpoint instead of throwing, and sends no request", async () => {
    vi.stubEnv("R2_ALLOW_INSECURE_HTTP", "");
    const fetchImpl = vi.fn();

    const result = await putR2ObjectIf({
      endpoint: "not a url", bucket: "b", key: "k", ...creds, body: "x", fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("buildCanonicalRequest with signed extra headers", () => {
  it("signs the extra headers in sorted order after host, lowercased", () => {
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest(
      "PUT",
      "/b/k",
      "q=1",
      "acc.r2.cloudflarestorage.com",
      { "If-Match": '"e"', "x-amz-meta-supabase-etag": '"s"' },
    );

    expect(signedHeaders).toBe("host;if-match;x-amz-meta-supabase-etag");
    expect(canonicalRequest).toContain(
      'host:acc.r2.cloudflarestorage.com\nif-match:"e"\nx-amz-meta-supabase-etag:"s"\n\nhost;if-match;x-amz-meta-supabase-etag\n',
    );
  });
});

describe("R2 delivery freshness gate", () => {
  const r2Config = { accountId: "acc-1", accessKeyId: "ak", secretAccessKey: "sk", bucket: "r2-b" };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("serves a presigned URL when the stored marker equals the current source ETag", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { "x-amz-meta-supabase-etag": '"src-1"' } }),
    );
    const adapter = new R2StorageAdapter({
      ...r2Config,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveSourceEtag: async () => '"src-1"',
    });

    const url = await adapter.createSignedDownloadUrl("book.pdf", 300);

    expect(url).toContain("https://acc-1.r2.cloudflarestorage.com/r2-b/book.pdf");
    expect(url).toContain("X-Amz-Signature=");
  });

  it("returns null on a marker mismatch and the composite falls back to the Supabase signed URL", async () => {
    vi.stubEnv("R2_ACCOUNT_ID", "acc-1");
    vi.stubEnv("R2_ACCESS_KEY_ID", "ak");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "sk");
    vi.stubEnv("R2_BUCKET_NAME", "r2-b");
    vi.stubEnv("R2_ENDPOINT", "https://acc-1.r2.cloudflarestorage.com");
    // R2 holds a copy written from an older source ETag.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200, headers: { "x-amz-meta-supabase-etag": '"old-1"' } }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const createSignedUrlMock = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://supabase.example/signed/book.pdf" },
      error: null,
    });
    const listMock = vi.fn().mockResolvedValue({
      data: [{ name: "book.pdf", metadata: { eTag: '"src-2"' } }],
      error: null,
    });
    const fakeSb = {
      storage: { from: vi.fn(() => ({ createSignedUrl: createSignedUrlMock, list: listMock })) },
    };

    const adapter = getDeliveryStorageAdapter(fakeSb as never, "supabase-bucket");
    const url = await adapter.createSignedDownloadUrl("book.pdf", 300);

    expect(url).toBe("https://supabase.example/signed/book.pdf");
    expect(createSignedUrlMock).toHaveBeenCalledWith("book.pdf", 300);
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("book.pdf");
    // Log only that the markers differ; never the ETag values.
    expect(logged).not.toContain("old-1");
    expect(logged).not.toContain("src-2");
  });

  it("returns null for an R2 object with no stored marker (legacy write)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200, headers: { etag: '"r2-1"' } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new R2StorageAdapter({
      ...r2Config,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveSourceEtag: async () => '"src-1"',
    });

    expect(await adapter.createSignedDownloadUrl("book.pdf", 300)).toBeNull();
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("legacy");
  });

  it("returns null when the current source ETag is unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { "x-amz-meta-supabase-etag": '"src-1"' } }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new R2StorageAdapter({
      ...r2Config,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveSourceEtag: async () => null,
    });

    expect(await adapter.createSignedDownloadUrl("book.pdf", 300)).toBeNull();
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("source ETag unknown");
  });

  it("resolveSupabaseSourceEtag returns null, without throwing, when the listing throws or errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwingSb = {
      storage: { from: () => ({ createSignedUrl: vi.fn(), list: vi.fn().mockRejectedValue(new Error("network down")) }) },
    };
    const erroringSb = {
      storage: {
        from: () => ({
          createSignedUrl: vi.fn(),
          list: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }),
        }),
      },
    };

    await expect(resolveSupabaseSourceEtag(throwingSb as never, "b", "book.pdf")).resolves.toBeNull();
    await expect(resolveSupabaseSourceEtag(erroringSb as never, "b", "book.pdf")).resolves.toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it("resolveSupabaseSourceEtag matches the exact file name, not a prefix match", async () => {
    const listMock = vi.fn().mockResolvedValue({
      data: [{ name: "book.pdf.bak", metadata: { eTag: '"bak"' } }],
      error: null,
    });
    const sb = { storage: { from: () => ({ createSignedUrl: vi.fn(), list: listMock }) } };

    expect(await resolveSupabaseSourceEtag(sb as never, "b", "folder/book.pdf")).toBeNull();
    expect(listMock).toHaveBeenCalledWith("folder", { search: "book.pdf", limit: 100 }, { signal: expect.any(AbortSignal) });

    listMock.mockResolvedValueOnce({
      data: [
        { name: "book.pdf.bak", metadata: { eTag: '"bak"' } },
        { name: "book.pdf", metadata: { eTag: '"exact"' } },
      ],
      error: null,
    });
    expect(await resolveSupabaseSourceEtag(sb as never, "b", "folder/book.pdf")).toBe('"exact"');
  });
});

describe("resolveSupabaseSourceEtag timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null once the listing exceeds the bound, so the download falls back", async () => {
    vi.useFakeTimers();
    const hungListing = vi.fn(() => new Promise<never>(() => {}));
    const sbAdmin = { storage: { from: () => ({ createSignedUrl: vi.fn(), list: hungListing }) } };

    const pending = resolveSupabaseSourceEtag(sbAdmin as never, "release-files", "books/hung.pdf");
    await vi.advanceTimersByTimeAsync(SOURCE_LISTING_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
    expect(hungListing).toHaveBeenCalledTimes(1);
  });

  it("aborts the in-flight listing request when the bound is hit, not just stops waiting for it", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    // A listing that rejects only when the signal it was given is aborted, as the real client does.
    const cancellableListing = vi.fn((_dir: string, _opts: unknown, parameters?: { signal?: AbortSignal }) => {
      observedSignal = parameters?.signal;
      return new Promise<never>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const sbAdmin = { storage: { from: () => ({ createSignedUrl: vi.fn(), list: cancellableListing }) } };

    const pending = resolveSupabaseSourceEtag(sbAdmin as never, "release-files", "books/slow.pdf");
    expect(observedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(SOURCE_LISTING_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
    expect(observedSignal?.aborted).toBe(true);
  });
});
