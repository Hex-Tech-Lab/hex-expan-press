// Wave 7.2: Polar refund parsing must distinguish "amount supplied" from "amount
// lost". Polar ALWAYS sends order_id + amount + tax_amount on refunds and supports
// partial refunds, so a refund missing/malforming any of them is a 400 — never an
// amount-less event the ledger would treat as a full reversal.
import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { PolarAdapter } from "../polar.adapter.ts";
import type { RefundIssuedEvent } from "../../../domain/payments/payments.port.ts";

const KEY = "wave72-polar-adapter-test-key";

function signed(payload: string) {
  const id = "whid_refund_0001";
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", Buffer.from(KEY, "utf8")).update(`${id}.${ts}.${payload}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` };
}

const refund = (data: Record<string, unknown>) =>
  JSON.stringify({ type: "refund.created", data: { id: "rf_1", order_id: "ord_1", amount: 3500, tax_amount: 400, created_at: "2026-09-30T00:00:00.000Z", ...data } });

async function parse(body: string) {
  vi.stubEnv("POLAR_WEBHOOK_SECRET", KEY);
  return new PolarAdapter().parseAndValidateWebhook(signed(body), body);
}

describe("PolarAdapter refund parsing (Wave 7.2)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("maps a well-formed refund: saleId = order_id, totalCents = amount + tax_amount", async () => {
    const res = await parse(refund({}));
    expect(res.isValid).toBe(true);
    const ev = (res as { event: RefundIssuedEvent }).event;
    expect(ev).toMatchObject({ eventType: "refund_issued", saleId: "ord_1", refundId: "rf_1", totalCents: 3900 });
  });

  it.each([
    ["amount missing", { amount: undefined }],
    ["amount malformed (string)", { amount: "3500" }],
    ["amount negative", { amount: -1 }],
    ["tax_amount missing", { tax_amount: undefined }],
    ["order_id missing (cannot link to a sale)", { order_id: undefined }],
    ["order_id empty", { order_id: "" }],
  ])("rejects a refund with %s → 400, no event", async (_label, patch) => {
    const res = await parse(refund(patch));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(400);
  });
});
