// A genuine signed delivery for a switched-off rail (Polar, with the inline defaults) is refused with a terminal 400
// and recorded for manual review as WEBHOOK_PROVIDER_SWITCHED_OFF, which the admin queue shows. An unverified one is
// refused with the same 400 and writes nothing. Nothing reaches the ledger in either case.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { POST as billingPost } from "../route";
import { standardWebhookHeaders } from "./support/webhook_signer";

const inserts = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const insertFails = vi.hoisted(() => ({ on: false }));

// Capture audit_log inserts without a database. The route only reaches Supabase on the quarantine path.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        return { abortSignal: async () => ({ error: insertFails.on ? { message: "audit_log unavailable" } : null }) };
      },
    }),
  }),
}));

const asNextRequest = (req: Request): NextRequest => req as unknown as NextRequest;
const KEY = "switched-off-manual-review-test-key";
const URL_ = "http://localhost:3000/api/billing/webhook";

const PAYLOAD = JSON.stringify({
  type: "order.paid",
  data: { id: "ord_off_mr_0001", paid: true, total_amount: 900, currency: "usd", product_id: "polar_prod_off_0001", created_at: "2026-11-03T00:00:00.000Z", customer: { email: "buyer@example.com" } },
});

function post(headers: Record<string, string>, body: string) {
  return billingPost(asNextRequest(new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body })));
}

describe("switched-off rail: signed delivery is recorded for manual review", () => {
  beforeEach(() => {
    inserts.length = 0;
    insertFails.on = false;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLAR_WEBHOOK_SECRET", KEY);
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.test");
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-only-not-a-secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a genuine signed sale for the off rail: 400, one WEBHOOK_PROVIDER_SWITCHED_OFF row, no ledger", async () => {
    const res = await post(standardWebhookHeaders(KEY, "whid_off_mr_0001", PAYLOAD), PAYLOAD);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "Bad Request" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      event: "WEBHOOK_PROVIDER_SWITCHED_OFF",
      details: { provider: "polar", reason: "provider_switched_off", sale_id: "ord_off_mr_0001" },
    });
    expect(String((inserts[0].details as { payload_sha256?: unknown }).payload_sha256)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the audit row stores a hash of the body, never the raw body (buyer PII)", async () => {
    await post(standardWebhookHeaders(KEY, "whid_off_mr_0002", PAYLOAD), PAYLOAD);
    expect(JSON.stringify(inserts[0])).not.toContain("buyer@example.com");
  });

  // F1: a genuine delivery whose audit row cannot be written is the only trace of a real sale. Telling the
  // provider to stop (400) would lose it, so the answer is a retryable 503.
  it("a genuine delivery whose audit row FAILS to write: 503 with Retry-After, not a terminal 400", async () => {
    insertFails.on = true;
    const res = await post(standardWebhookHeaders(KEY, "whid_off_mr_0006", PAYLOAD), PAYLOAD);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(await res.json()).toEqual({ ok: false, error: "Temporarily unavailable — retry" });
  });

  it("a badly signed delivery for the off rail: 400, and NO row (unverified traffic writes nothing)", async () => {
    const headers = { ...standardWebhookHeaders(KEY, "whid_off_mr_0003", PAYLOAD), "webhook-signature": "v1,AAAA" };
    const res = await post(headers, PAYLOAD);
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it("a delivery with a stale timestamp for the off rail: 400, and NO row", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await post(standardWebhookHeaders(KEY, "whid_off_mr_0004", PAYLOAD, stale), PAYLOAD);
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it("with the Polar secret missing, a delivery for the off rail is still a terminal 400, not a retry loop (no 500)", async () => {
    vi.stubEnv("POLAR_WEBHOOK_SECRET", "");
    const res = await post(standardWebhookHeaders(KEY, "whid_off_mr_0005", PAYLOAD), PAYLOAD);
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });
});
