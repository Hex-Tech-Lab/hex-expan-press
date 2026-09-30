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
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { POST as billingPost } from "../route";

// The handler only consumes .body/.headers at runtime — the NextRequest
// wrapper fields are unused, so plain Requests are cast for type-checking.
const asNextRequest = (req: Request): NextRequest => req as unknown as NextRequest;

const HMAC_TEST_KEY = "wave6-unit-test-hmac-key";
const WEBHOOK_URL = "http://localhost:3000/api/billing/webhook";

function signedHeaders(payload: string, key = HMAC_TEST_KEY) {
  const id = "whid_test_0001";
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", Buffer.from(key, "utf8")).update(`${id}.${ts}.${payload}`).digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sig}`,
    "content-type": "application/json",
  };
}

// Unpaid order.created is routed to "ignored" by the Polar adapter: signature
// is fully verified (HMAC enforced), but nothing touches the ledger or
// product index — so the 200 proves the signature path without side effects.
const IGNORED_PAYLOAD = JSON.stringify({
  type: "order.created",
  data: {
    id: "ord_test_native_0001",
    paid: false,
    total_amount: 0,
    currency: "usd",
    created_at: "2026-09-28T00:00:00.000Z",
    customer: { email: "buyer@example.com", name: "Jürgen Müller" },
  },
});

describe("billing webhook native route (Wave 6)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("verifies a VALID signature over the raw body (end-to-end 200)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLAR_WEBHOOK_SECRET", HMAC_TEST_KEY);
    const res = await billingPost(
      asNextRequest(new Request(WEBHOOK_URL, { method: "POST", headers: signedHeaders(IGNORED_PAYLOAD), body: IGNORED_PAYLOAD })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // Wave 7.2: a VALIDLY SIGNED Polar refund whose amount is missing must be a 400
  // through the real route (adapter schema), never reach the ledger as amount-less.
  it("rejects a signed Polar refund with no amount → 400 (real adapter, no ledger write)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLAR_WEBHOOK_SECRET", HMAC_TEST_KEY);
    const payload = JSON.stringify({ type: "refund.created", data: { id: "rf_x", order_id: "ord_x", tax_amount: 0 } });
    const res = await billingPost(
      asNextRequest(new Request(WEBHOOK_URL, { method: "POST", headers: signedHeaders(payload), body: payload })),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a tampered body with 400 when signatures are enforced", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLAR_WEBHOOK_SECRET", HMAC_TEST_KEY);
    const tampered = IGNORED_PAYLOAD.replace("ord_test_native_0001", "ord_tampered");
    const res = await billingPost(
      asNextRequest(new Request(WEBHOOK_URL, { method: "POST", headers: signedHeaders(IGNORED_PAYLOAD), body: tampered })),
    );
    expect(res.status).toBe(400);
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

  it("round-trips multi-byte UTF-8 byte-exactly (HMAC over a >64KB body verifies)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLAR_WEBHOOK_SECRET", HMAC_TEST_KEY);
    // The payload only verifies if the route's Buffer-concat body read is
    // byte-identical to what was signed — string corruption (e.g. the old
    // chunk-concatenation hazard) would flip the digest and 400 here.
    const payload = JSON.stringify({
      type: "order.created",
      data: {
        id: "ord_test_utf8_0001",
        paid: false,
        total_amount: 0,
        currency: "usd",
        created_at: "2026-09-28T00:00:00.000Z",
        customer: { email: "buyer@example.com", name: `€✓漢字 ${"é".repeat(40_000)}` },
      },
    });
    const res = await billingPost(
      asNextRequest(new Request(WEBHOOK_URL, { method: "POST", headers: signedHeaders(payload), body: payload })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
