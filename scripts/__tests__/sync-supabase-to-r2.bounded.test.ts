import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fetchSourceObject, isDirectRun, syncSupabaseToR2 } from "../sync-supabase-to-r2";
import { GLOBAL, PAYMENTS_LIMITS } from "../../payments/src/settings_registry";

// Streams the given chunks as a response body with no Content-Length, so only the streaming counter can stop it.
function streamedResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

const args = ["https://test.supabase.co", "key", "release-files", "books/a.pdf"] as const;

describe("fetchSourceObject byte cap", () => {
  it("returns the bytes and etag when the body is under the cap", async () => {
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])], { etag: '"e1"' }));
    const out = await fetchSourceObject(fetchImpl as never, ...args, 10);
    expect([...out.bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(out.etag).toBe('"e1"');
  });

  it("refuses a declared Content-Length over the cap before reading the body", async () => {
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array(4)], { "content-length": "999" }));
    await expect(fetchSourceObject(fetchImpl as never, ...args, 10)).rejects.toThrow(/declares 999 bytes, over the 10-byte cap/);
  });

  it("stops a streamed body that passes the cap even with no Content-Length", async () => {
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array(6), new Uint8Array(6)]));
    await expect(fetchSourceObject(fetchImpl as never, ...args, 10)).rejects.toThrow(/exceeded the 10-byte cap while streaming/);
  });

  it("refuses a non-https SUPABASE_URL before any request is sent", async () => {
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array(1)]));
    await expect(fetchSourceObject(fetchImpl as never, "http://supabase.example.com", "key", "release-files", "a.pdf", 10)).rejects.toThrow(/must be https/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows http only for loopback", async () => {
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array([9])]));
    const out = await fetchSourceObject(fetchImpl as never, "http://127.0.0.1:54321", "key", "release-files", "a.pdf", 10);
    expect([...out.bytes]).toEqual([9]);
  });

  it("refuses a 2xx response that declares bytes but has no body", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200, headers: { "content-length": "5" } }));
    await expect(fetchSourceObject(fetchImpl as never, ...args, 10)).rejects.toThrow(/declared 5 bytes but returned no body/);
  });

  it("cancels the body of a non-2xx response before throwing", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 500 }));
    await expect(fetchSourceObject(fetchImpl as never, ...args, 10)).rejects.toThrow(/HTTP 500/);
    expect(cancel).toHaveBeenCalled();
  });

  it("refuses a body shorter than its identity-encoded declared length", async () => {
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array(2)], { "content-length": "5" }));
    await expect(fetchSourceObject(fetchImpl as never, ...args, 10)).rejects.toThrow(/declared 5 bytes but delivered 2/);
  });

  it("does not compare lengths for a gzip-encoded body", async () => {
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array(2)], { "content-length": "5", "content-encoding": "gzip" }));
    const out = await fetchSourceObject(fetchImpl as never, ...args, 10);
    expect(out.bytes.byteLength).toBe(2);
  });

  it("refuses a mismatched identity body whose content-encoding is upper-case", async () => {
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array(2)], { "content-length": "5", "content-encoding": "IDENTITY" }));
    await expect(fetchSourceObject(fetchImpl as never, ...args, 10)).rejects.toThrow(/declared 5 bytes but delivered 2/);
  });

  it("refuses a non-numeric content-length", async () => {
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array(1)], { "content-length": "5x" }));
    await expect(fetchSourceObject(fetchImpl as never, ...args, 10)).rejects.toThrow(/non-numeric content-length/);
  });

  it("syncSupabaseToR2 sends no network request before refusing an http URL", async () => {
    // The real client path: the bucket listing goes through the global fetch, so any request made before the guard
    // is seen here, whichever helper made it.
    const sourceFetchImpl = vi.fn();
    const globalFetch = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        syncSupabaseToR2({ supabaseUrl: "http://remote-probe.example.test", supabaseServiceRoleKey: "k", sourceFetchImpl: sourceFetchImpl as never }),
      ).rejects.toThrow(/must be https/);
      expect(sourceFetchImpl).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });

  it("refuses a 200 with no body and no content-length rather than accepting zero bytes", async () => {
    // Without this, the sync would write an empty object and stamp its ETag, and later runs would skip it as synced.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(fetchSourceObject(fetchImpl as never, ...args, 10)).rejects.toThrow(/returned no body/);
  });

  it("a failing body cancel does not replace the cap error", async () => {
    const cancel = vi.fn(async () => { throw new Error("cancel failed"); });
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4)); }, cancel });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { "content-length": "999" } }));
    await expect(fetchSourceObject(fetchImpl as never, ...args, 10)).rejects.toThrow(/declares 999 bytes, over the 10-byte cap/);
  });

  it("a failing cancel does not replace the cap error when the stream overruns while streaming", async () => {
    // No Content-Length, so only the streamed counter can stop it, and the cancel happens on the reader path.
    const cancel = vi.fn(async () => { throw new Error("cancel failed"); });
    let i = 0;
    // Three chunks: the overrun is seen on the second, so the stream is still open and cancel reaches the source.
    // With only two, the stream closes before the check and cancel is a no-op.
    const chunks = [new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { if (i < chunks.length) controller.enqueue(chunks[i++]); else controller.close(); },
      cancel,
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    await expect(fetchSourceObject(fetchImpl as never, ...args, 10)).rejects.toThrow(/exceeded the 10-byte cap while streaming/);
    expect(cancel).toHaveBeenCalled();
  });

  it("a failing body cancel does not replace the HTTP status error", async () => {
    const cancel = vi.fn(async () => { throw new Error("cancel failed"); });
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 503 }));
    await expect(fetchSourceObject(fetchImpl as never, ...args, 10)).rejects.toThrow(/returned HTTP 503/);
  });

  it("syncSupabaseToR2 refuses an http URL before the bucket listing runs", async () => {
    const from = vi.fn();
    await expect(
      syncSupabaseToR2({
        supabaseUrl: "http://remote-probe.example.test",
        supabaseServiceRoleKey: "k",
        supabaseClient: { storage: { from } } as never,
        r2AccountId: "a",
        r2AccessKeyId: "b",
        r2SecretAccessKey: "c",
        r2BucketName: "d",
      }),
    ).rejects.toThrow(/must be https/);
    expect(from).not.toHaveBeenCalled();
  });

  it("isDirectRun is true only for this file, not for a lookalike name", () => {
    const self = fileURLToPath(new URL("../sync-supabase-to-r2.ts", import.meta.url));
    expect(isDirectRun(self)).toBe(true);
    expect(isDirectRun("/work/sync-supabase-to-r2-evil.ts")).toBe(false);
    expect(isDirectRun(undefined)).toBe(false);
  });

  it("isDirectRun accepts the extensionless argv[1] that tsx reports", () => {
    const self = fileURLToPath(new URL("../sync-supabase-to-r2.ts", import.meta.url));
    expect(isDirectRun(self.replace(/\.ts$/, ""))).toBe(true);
    expect(isDirectRun(self.replace(/sync-supabase-to-r2\.ts$/, "sync-supabase-to-r2-evil"))).toBe(false);
  });

  it("keeps the registry default inside its declared bounds", () => {
    const { min, max } = PAYMENTS_LIMITS.sync_max_object_bytes;
    const setting = GLOBAL.payments.sync_max_object_bytes;
    expect(typeof setting).toBe("number");
    expect(setting).toBeGreaterThanOrEqual(min);
    expect(setting).toBeLessThanOrEqual(max);
  });

  it("applies the registry default when no cap is passed", async () => {
    // Declared length one byte over the registry default: refused only if the default is wired in.
    const over = GLOBAL.payments.sync_max_object_bytes + 1;
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array(0)], { "content-length": String(over) }));
    await expect(fetchSourceObject(fetchImpl as never, ...args)).rejects.toThrow(/declares \d+ bytes, over the \d+-byte cap/);
  });

  it("accepts a declared length exactly at the cap", async () => {
    const at = 8;
    const fetchImpl = vi.fn(async () => streamedResponse([new Uint8Array(8)], { "content-length": String(at) }));
    const out = await fetchSourceObject(fetchImpl as never, ...args, at);
    expect(out.bytes.byteLength).toBe(8);
  });
});
