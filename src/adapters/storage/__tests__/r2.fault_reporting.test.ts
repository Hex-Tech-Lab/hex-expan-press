import { afterEach, describe, expect, it, vi } from "vitest";
import { R2StorageAdapter, setStorageFailureReporter, type StorageFailureReporter } from "../r2.adapter";

// Every R2 fault that makes a download fall through must reach the registered reporter (Sentry in the web app).
const base = { accountId: "acc-123", accessKeyId: "ak-123", secretAccessKey: "sk-123", bucket: "books-bucket" };

describe("R2 tier faults reach the registered reporter", () => {
  let report: ReturnType<typeof vi.fn<StorageFailureReporter>>;

  afterEach(() => {
    setStorageFailureReporter((message, tags) => console.error(message, tags));
    vi.restoreAllMocks();
  });

  function register(): void {
    report = vi.fn<StorageFailureReporter>();
    setStorageFailureReporter(report);
  }

  it("reports not_seeded when the object is missing from R2", async () => {
    register();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const adapter = new R2StorageAdapter({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 404 })) as unknown as typeof fetch,
      resolveSourceEtag: async () => '"src-1"',
    });
    expect(await adapter.createSignedDownloadUrl("release.pdf", 600)).toBeNull();
    expect(report).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ surface: "r2_storage", reason: "not_seeded" }));
  });

  it("reports stale when the stored marker differs from the source", async () => {
    register();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = new R2StorageAdapter({
      ...base,
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(null, { status: 200, headers: { "x-amz-meta-supabase-etag": '"old"' } }),
      ) as unknown as typeof fetch,
      resolveSourceEtag: async () => '"new"',
    });
    expect(await adapter.createSignedDownloadUrl("release.pdf", 600)).toBeNull();
    expect(report).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ surface: "r2_storage", reason: "stale" }));
  });

  it("reports unavailable with the error name only when R2 cannot be reached", async () => {
    register();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const networkError = new TypeError("fetch failed");
    const adapter = new R2StorageAdapter({
      ...base,
      fetchImpl: vi.fn().mockRejectedValue(networkError) as unknown as typeof fetch,
      resolveSourceEtag: async () => '"src-1"',
    });
    expect(await adapter.createSignedDownloadUrl("release.pdf", 600)).toBeNull();
    expect(report).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ surface: "r2_storage", reason: "unavailable", error_name: "TypeError" }),
    );
  });

  it("keeps the message constant, so Sentry groups every fault of one kind together", async () => {
    register();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const adapter = new R2StorageAdapter({
      ...base,
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("boom")) as unknown as typeof fetch,
      resolveSourceEtag: async () => '"src-1"',
    });
    await adapter.createSignedDownloadUrl("a.pdf", 600);
    await adapter.createSignedDownloadUrl("b.pdf", 600);
    const messages = report.mock.calls.map((call) => call[0]);
    expect(new Set(messages).size).toBe(1);
  });
});
