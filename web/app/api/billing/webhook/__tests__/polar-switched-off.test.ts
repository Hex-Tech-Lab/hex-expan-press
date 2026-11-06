// Pins the switched-off Polar rail through the real webhook route. Polar keeps its
// verifier and config so it can be turned on by a settings change, but with the switch
// off a delivery that would otherwise verify is refused and never reaches the ledger.
import { describe, it, expect, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { POST as billingPost } from "../route";
import { standardWebhookHeaders } from "./support/webhook_signer";

// Hermetic: a local data/settings/providers.json must not change the switch, and the sales ledger must never be
// written (CLAUDE.md: tests must not write the production ledger). The ledger mock lets the test assert no write.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => false };
});
vi.mock("../../../../../../payments/src/ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../payments/src/ledger")>();
  return { ...actual, appendSale: vi.fn(async () => { throw new Error("ledger written while the rail is switched off"); }) };
});

// The switched-off audit insert goes to a stub that succeeds, so the refusal can be a terminal 400.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: () => ({ abortSignal: async () => ({ error: null }) }),
      upsert: () => ({ abortSignal: async () => ({ error: null }) }),
    }),
  }),
}));

const asNextRequest = (req: Request): NextRequest => req as unknown as NextRequest;
const KEY = "polar-switched-off-test-key";
const URL_ = "http://localhost:3000/api/billing/webhook";

function signed(payload: string) {
  return { ...standardWebhookHeaders(KEY, "whid_off_0001", payload), "content-type": "application/json" };
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
    const ledger = await import("../../../../../../payments/src/ledger");
    expect(vi.mocked(ledger.appendSale)).not.toHaveBeenCalled();
  });
});
