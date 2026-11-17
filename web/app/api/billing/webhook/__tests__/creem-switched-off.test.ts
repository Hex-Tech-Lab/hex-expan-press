// F-17. A validly signed Creem refund or dispute on a switched-off rail is a money event the adapter refuses with 422.
// The switched-off audit row is written first, and the 422 is returned only once that row exists. The provider is
// identified from the creem-signature header, so the row carries provider "creem".
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { createWebhookHandler } from "../handler";
import { CreemAdapter } from "../../../../../../src/adapters/payments/creem.adapter.ts";

const inserts = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const insertFails = vi.hoisted(() => ({ on: false }));

// Capture audit_log writes without a database.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push({ ...row, op: "insert" });
        return { abortSignal: async () => ({ error: insertFails.on ? { message: "audit_log unavailable" } : null }) };
      },
      upsert: (row: Record<string, unknown>) => {
        inserts.push({ ...row, op: "upsert" });
        return { abortSignal: async () => ({ error: insertFails.on ? { message: "audit_log unavailable" } : null }) };
      },
    }),
  }),
}));

const SECRET = "whsec_creem_switched_off_test";
const URL_ = "http://localhost:3000/api/billing/webhook";

const REFUND = JSON.stringify({
  id: "evt_creem_refund_off_1",
  eventType: "refund.created",
  created_at: 1728734325927,
  object: { id: "re_creem_off_1", mode: "live", amount: 1900, currency: "usd" },
});

function signedHeaders(body: string, secret = SECRET): Record<string, string> {
  return { "creem-signature": crypto.createHmac("sha256", secret).update(body).digest("hex"), "content-type": "application/json" };
}

// The Creem rail is the only switched-off rail; no switched-on rail claims the delivery, so the handler takes the switched-off path.
const handler = createWebhookHandler(
  () => [],
  () => [new CreemAdapter()],
);

function post(headers: Record<string, string>, body: string) {
  return handler(new Request(URL_, { method: "POST", headers, body }) as unknown as NextRequest);
}

describe("switched-off Creem rail: validly signed refund (F-17)", () => {
  beforeEach(() => {
    inserts.length = 0;
    insertFails.on = false;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CREEM_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.test");
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-only-not-a-secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("writes one WEBHOOK_PROVIDER_SWITCHED_OFF row with provider creem, then answers 422", async () => {
    const res = await post(signedHeaders(REFUND), REFUND);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "Unprocessable Entity" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      event: "WEBHOOK_PROVIDER_SWITCHED_OFF",
      details: { provider: "creem", reason: "provider_switched_off" },
    });
    expect(inserts[0]).toMatchObject({
      op: "upsert",
      idempotency_key: expect.stringMatching(/^WEBHOOK_PROVIDER_SWITCHED_OFF:creem:[0-9a-f]{64}$/),
    });
  });

  it("when the audit row cannot be written, the answer is a retryable 503, never a 422 that drops the event", async () => {
    insertFails.on = true;
    const res = await post(signedHeaders(REFUND), REFUND);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(inserts).toHaveLength(1); // the write was attempted before the answer
  });

  it("a badly signed refund is unverified: 400 and NO row", async () => {
    const res = await post(signedHeaders(REFUND, "wrong-secret"), REFUND);
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });
});
