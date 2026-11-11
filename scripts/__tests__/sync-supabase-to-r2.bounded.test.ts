import { describe, expect, it, vi } from "vitest";
import { fetchSourceObject } from "../sync-supabase-to-r2";
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

  it("keeps the registry default inside its declared bounds", () => {
    const { min, max } = PAYMENTS_LIMITS.sync_max_object_bytes;
    const v = GLOBAL.payments.sync_max_object_bytes;
    expect(typeof v).toBe("number");
    expect(v).toBeGreaterThanOrEqual(min);
    expect(v).toBeLessThanOrEqual(max);
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
