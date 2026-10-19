// Regression test for the NATIVE billing webhook route handler (Wave 6 —
// replaces the shim-bridged legacy handler; the shim-era bridge tests died
// with web/app/api/_legacy).
//
// Covers one contract in this file: oversized streamed bodies are rejected
// 413 mid-read (no Content-Length trust), so a flood of huge POSTs cannot
// buffer in memory.
//
// Not covered here (open debt, CLAUDE.md Tooling Debt):
//   - a VALID provider signature verifying end-to-end;
//   - a tampered body rejecting 400 when signatures are enforced;
//   - multi-byte UTF-8 surviving byte-exactly through Buffer.concat.
import { describe, it, expect, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { POST as billingPost } from "../route";

// The handler only consumes .body/.headers at runtime — the NextRequest
// wrapper fields are unused, so plain Requests are cast for type-checking.
const asNextRequest = (req: Request): NextRequest => req as unknown as NextRequest;

const WEBHOOK_URL = "http://localhost:3000/api/billing/webhook";

describe("billing webhook native route: streamed body cap (413)", () => {
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
