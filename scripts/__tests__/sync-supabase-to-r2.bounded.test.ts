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

  it("keeps the registry default inside its declared bounds", () => {
    const { min, max } = PAYMENTS_LIMITS.sync_max_object_bytes;
    const v = GLOBAL.payments.sync_max_object_bytes;
    expect(v).toBeGreaterThanOrEqual(min);
    expect(v).toBeLessThanOrEqual(max);
  });
});
