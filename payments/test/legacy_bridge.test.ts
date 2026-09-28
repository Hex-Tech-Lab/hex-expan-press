// Regression tests for the Next.js legacy-handler bridge (web/app/api/_legacy/shim.ts)
// and the billing webhook route that wraps it.
//
// Motivated by external review findings (Cubic founder review + CodeRabbit 2026-09-28):
//  1. A VALID provider signature over a body that traversed the shim must verify
//     end-to-end (prior smoke evidence was ephemeral, not durable in-repo).
//  2. The body cap must reject oversized POSTs even without a trustworthy
//     Content-Length (413), without buffering first.
//  3. Multi-byte UTF-8 must survive the bridge (the shim emits the buffered body
//     as ONE chunk — legacy handlers accumulate chunks via string concatenation).
import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { POST as billingPost } from "../../web/app/api/billing/webhook/route.ts";
import { runLegacyHandler } from "../../web/app/api/_legacy/shim.ts";

const SECRET = "bridge-test-secret";
const WEBHOOK_URL = "http://localhost:3000/api/billing/webhook";

function signedHeaders(payload: string, secret = SECRET) {
  const id = "whid_test_0001";
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${ts}.${payload}`).digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sig}`,
    "content-type": "application/json",
  };
}

// Unpaid order.created is routed to "ignored" by the Polar adapter: signature is
// fully verified (HMAC enforced), but nothing touches the ledger or product index.
const IGNORED_PAYLOAD = JSON.stringify({
  type: "order.created",
  data: {
    id: "ord_test_bridge_0001",
    paid: false,
    total_amount: 0,
    currency: "usd",
    created_at: "2026-09-28T00:00:00.000Z",
    customer: { email: "buyer@example.com", name: "Jürgen Müller" },
  },
});

describe("legacy bridge (shim + billing webhook route)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("verifies a VALID signature over a body that traversed the shim (end-to-end 200)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLAR_WEBHOOK_SECRET", SECRET);
    const res = await billingPost(
      new Request(WEBHOOK_URL, { method: "POST", headers: signedHeaders(IGNORED_PAYLOAD), body: IGNORED_PAYLOAD }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects a tampered body with 400 when signatures are enforced (NODE_ENV=production)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLAR_WEBHOOK_SECRET", SECRET);
    const tampered = IGNORED_PAYLOAD.replace("ord_test_bridge_0001", "ord_tampered");
    const res = await billingPost(
      new Request(WEBHOOK_URL, { method: "POST", headers: signedHeaders(IGNORED_PAYLOAD), body: tampered }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 413 for a streamed body over the cap with no Content-Length", async () => {
    const big = Buffer.alloc(700 * 1024, 0x61);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(big));
        controller.enqueue(new Uint8Array(big));
        controller.close();
      },
    });
    const res = await billingPost(
      new Request(WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        // Node fetch requires duplex when streaming a request body
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
  });

  it("returns 413 from the Content-Length pre-check before reading the body", async () => {
    const res = await billingPost(
      new Request(WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024) },
        body: JSON.stringify({ small: true }),
      }),
    );
    expect(res.status).toBe(413);
  });

  it("round-trips multi-byte UTF-8 larger than the old 64KB chunk boundary", async () => {
    const text = `€✓漢字 — bridged body must stay byte-identical ${"é".repeat(40_000)}`;
    const out = await runLegacyHandler(new Request("http://localhost/x", { method: "POST", body: text }), async (req, res) => {
      let acc = "";
      for await (const chunk of req) acc += chunk;
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(acc);
    });
    expect(out.status).toBe(200);
    expect(await out.text()).toBe(text);
  });
});
