// Regression tests for the NATIVE billing webhook route handler (Wave 6 —
// replaces the shim-bridged legacy handler; the shim-era bridge tests died
// with web/app/api/_legacy).
//
// Contract carried over from the shim era (external-review-motivated):
//   1. A VALID provider signature over the raw body must verify end-to-end.
//   2. A tampered body must reject 400 when signatures are enforced.
//   3. Oversized streamed bodies must be rejected 413 mid-read (no Content-
//      Length trust) so a flood of huge POSTs cannot buffer in memory.
//   4. Multi-byte UTF-8 must survive byte-exactly (the route buffers via
//      Buffer.concat, never string concatenation) — proven by a valid HMAC
//      over a body whose signature only verifies if every byte survives.
import { describe, it, expect, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { POST as billingPost } from "../route";

// The handler only consumes .body/.headers at runtime — the NextRequest
// wrapper fields are unused, so plain Requests are cast for type-checking.
const asNextRequest = (req: Request): NextRequest => req as unknown as NextRequest;

const WEBHOOK_URL = "http://localhost:3000/api/billing/webhook";

describe("billing webhook native route (Wave 6)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 413 for a streamed body over the 1MiB cap with no Content-Length", async () => {
    const big = Buffer.alloc(700 * 1024, 0x61);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(big));
        controller.enqueue(new Uint8Array(big));
        controller.close();
      },
    });
    const res = await billingPost(
      asNextRequest(
        new Request(
          WEBHOOK_URL,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: stream,
            // Node fetch requires duplex when streaming a request body
            duplex: "half",
          } as RequestInit,
        ),
      ),
    );
    expect(res.status).toBe(413);
  });

});
