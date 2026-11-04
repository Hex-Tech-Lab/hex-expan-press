// Pins the switched-off Polar rail through the real webhook route. Polar keeps its
// verifier and config so it can be turned on by a settings change, but with the switch
// off a delivery that would otherwise verify is refused and never reaches the ledger.
import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { POST as billingPost } from "../route";

// The switched-off audit insert goes to a stub that succeeds, so the refusal can be a terminal 400.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: () => ({ abortSignal: async () => ({ error: null }) }) }) }),
}));

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
  data: { id: "ord_off_0001", paid: true, total_amount: 900, currency: "usd", product_id: "polar_prod_off_0001", created_at: "2026-11-03T00:00:00.000Z", customer: { email: "buyer@example.com" } },
});

describe("Polar switched off (launch switch)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a correctly signed Polar sale while the switch is off", async () => {
    // The 400 is only given once the switched-off audit row is written, so the audit write must succeed here.
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.test");
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-only-not-a-secret");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLAR_WEBHOOK_SECRET", KEY);
    const res = await billingPost(asNextRequest(new Request(URL_, { method: "POST", headers: signed(PAYLOAD), body: PAYLOAD })));
    expect(res.status).toBe(400); // refused by the switch, not by payload validation (the payload is a complete paid order)
    expect(await res.json()).toEqual({ ok: false, error: "Bad Request" });
  });
});
