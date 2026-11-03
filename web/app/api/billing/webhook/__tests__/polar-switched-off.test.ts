// Pins the switched-off Polar rail through the real webhook route. Polar keeps its
// verifier and config so it can be turned on by a settings change, but with the switch
// off a delivery that would otherwise verify is refused and never reaches the ledger.
import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { POST as billingPost } from "../route";

const asNextRequest = (req: Request): NextRequest => req as unknown as NextRequest;
const KEY = "polar-switched-off-test-key";
const URL_ = "http://localhost:3000/api/billing/webhook";

function signed(payload: string) {
  const id = "whid_off_0001";
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", Buffer.from(KEY, "utf8")).update(`${id}.${ts}.${payload}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}`, "content-type": "application/json" };
}

const PAYLOAD = JSON.stringify({
  type: "order.paid",
  data: { id: "ord_off_0001", paid: true, total_amount: 900, currency: "usd", created_at: "2026-11-03T00:00:00.000Z", customer: { email: "buyer@example.com" } },
});

describe("Polar switched off (launch switch)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a correctly signed Polar sale while the switch is off", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLAR_WEBHOOK_SECRET", KEY);
    const res = await billingPost(asNextRequest(new Request(URL_, { method: "POST", headers: signed(PAYLOAD), body: PAYLOAD })));
    expect(res.status).not.toBe(200);
  });
});
