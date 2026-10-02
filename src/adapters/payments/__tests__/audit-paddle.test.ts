// AUDIT 2026-10-02 (F3 refunds ignored, F4 non-USD totals booked as USD).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { PaddleAdapter } from "../paddle.adapter.ts";

const SECRET = crypto.randomBytes(16).toString("hex");
function signed(payload: unknown) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const h1 = crypto.createHmac("sha256", SECRET).update(`${ts}:${body}`).digest("hex");
  return { body, headers: { "paddle-signature": `ts=${ts};h1=${h1}` } };
}

describe("PaddleAdapter audit", () => {
  beforeEach(() => {
    vi.stubEnv("PADDLE_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("PADDLE_ENVIRONMENT", "sandbox");
    vi.stubEnv("PADDLE_PRICE_MAP", JSON.stringify({ pri_x: "prod_x" }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("F3: a full refund adjustment is a refund_issued event, not ignored", async () => {
    const { body, headers } = signed({
      event_type: "adjustment.updated",
      data: { id: "adj_1", action: "refund", status: "approved", transaction_id: "txn_1", currency_code: "USD",
              totals: { total: "3900" } },
    });
    const r = await new PaddleAdapter().parseAndValidateWebhook(headers, body);
    expect(r.isValid && r.event.eventType).toBe("refund_issued");
  });

  it("F4: a EUR transaction is not accepted as a USD-denominated sale", async () => {
    const { body, headers } = signed({
      event_type: "transaction.completed",
      data: { id: "txn_eur", currency_code: "EUR", details: { totals: { total: "3900" } },
              items: [{ price: { id: "pri_x" } }], custom_data: { email: "b@example.com" },
              changed_at: new Date().toISOString() },
    });
    const r = await new PaddleAdapter().parseAndValidateWebhook(headers, body);
    expect(r.isValid).toBe(false);
  });

  it("F3: an approved chargeback is a refund_issued event linked to the transaction", async () => {
    const { body, headers } = signed({
      event_type: "adjustment.created",
      data: { id: "adj_2", action: "chargeback", status: "approved", transaction_id: "txn_9", currency_code: "USD",
              totals: { total: "3900" } },
    });
    const r = await new PaddleAdapter().parseAndValidateWebhook(headers, body);
    expect(r.isValid && r.event.eventType === "refund_issued" && r.event.saleId).toBe("txn_9");
  });

  it("F3: a pending refund adjustment is ignored until approved", async () => {
    const { body, headers } = signed({
      event_type: "adjustment.created",
      data: { id: "adj_3", action: "refund", status: "pending_approval", transaction_id: "txn_1", currency_code: "USD",
              totals: { total: "3900" } },
    });
    const r = await new PaddleAdapter().parseAndValidateWebhook(headers, body);
    expect(r.isValid && r.event.eventType).toBe("ignored");
  });

  it("F4: a EUR rejection is a 422", async () => {
    const { body, headers } = signed({
      event_type: "transaction.completed",
      data: { id: "txn_eur", currency_code: "EUR", details: { totals: { total: "3900" } },
              items: [{ price: { id: "pri_x" } }], custom_data: { email: "b@example.com" } },
    });
    const r = await new PaddleAdapter().parseAndValidateWebhook(headers, body);
    expect(!r.isValid && r.httpStatus).toBe(422);
  });
});
