// PR 136 Creem boundary checks: a signed but malformed checkout.completed is a terminal 400 at the adapter, never a
// thrown RangeError (a 500 retry loop). A buyer email's format never refuses a paid sale (delivery refuses an empty one).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { CreemAdapter } from "../creem.adapter.ts";

const SECRET = "whsec_test_creem_boundary";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

function delivery(edit: (event: Record<string, unknown>) => void): string {
  const event: Record<string, unknown> = {
    id: "evt_boundary_1",
    eventType: "checkout.completed",
    created_at: 1728734325927,
    object: {
      id: "ch_boundary_1",
      mode: "live",
      metadata: { order_ref: "order-ref-boundary" },
      order: { id: "ord_boundary_1", status: "paid", amount: 1900, amount_paid: 1900, currency: "usd", product: "prod_boundary_1", mode: "live" },
      customer: { email: "buyer@example.com" },
    },
  };
  edit(event);
  return JSON.stringify(event);
}

function headersFor(body: string): Record<string, string> {
  return { "creem-signature": sign(body), "content-type": "application/json" };
}

describe("CreemAdapter boundary validation", () => {
  const adapter = new CreemAdapter({ accept: false, databaseRef: "", supabaseUrl: undefined });
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevSecret = process.env.CREEM_WEBHOOK_SECRET;
    process.env.CREEM_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.CREEM_WEBHOOK_SECRET;
    else process.env.CREEM_WEBHOOK_SECRET = prevSecret;
  });

  it("a valid buyer email with a valid event time still yields a sale", async () => {
    const body = delivery(() => undefined);
    const res = await adapter.parseAndValidateWebhook(headersFor(body), body);
    expect(res.isValid).toBe(true);
    expect((res as { event?: { eventType: string } }).event?.eventType).toBe("sale_completed");
  });

  it.each(["abc", "buyer@", "not an address", "@example.com"])("accepts and books a paid sale whose buyer email is not an address (%p)", async (email) => {
    const body = delivery((e) => {
      (e.object as { customer: { email: string } }).customer.email = email;
    });
    const res = await adapter.parseAndValidateWebhook(headersFor(body), body);
    expect(res).toMatchObject({ isValid: true, event: { eventType: "sale_completed", buyerEmail: email } });
  });

  it.each([1e17, -1e17, 9e15])("answers 400 for an out-of-range event time (%p) instead of throwing RangeError", async (createdAt) => {
    const body = delivery((e) => {
      e.created_at = createdAt;
    });
    const res = await adapter.parseAndValidateWebhook(headersFor(body), body);
    expect(res).toMatchObject({ isValid: false, httpStatus: 400 });
  });
});
