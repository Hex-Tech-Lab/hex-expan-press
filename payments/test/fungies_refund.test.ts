import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { fungiesProvider } from "../src/providers/fungies.ts";

const SECRET = "unit-test-hmac-key-not-a-real-secret";

function signed(body: Record<string, unknown>) {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
  return { raw, headers: { "x-fngs-signature": `sha256_${sig}` } as Record<string, string> };
}

function parse(body: Record<string, unknown>) {
  const { raw, headers } = signed(body);
  return fungiesProvider.parseWebhook(headers, raw, SECRET);
}

function refundBody(saleId: string | undefined) {
  const payment: Record<string, unknown> = { id: saleId ?? undefined, value: 1900, currency: "USD", currencyDecimals: 2, createdAt: 1759000000000 };
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type: "payment_refunded",
    data: { items: [], order: { id: "ord_x", createdAt: 1759000000000 }, payment },
  };
}

// Scoped env stub (restored after each test) — never leaks into other suites.
beforeEach(() => {
  vi.stubEnv("FUNGIES_WEBHOOK_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fungies payment_refunded (translator-only — emits amount_unverifiable, engine routes to manual review)", () => {
  it("parses a full-shape refund event with amount_unverifiable=true and mapped sale id", () => {
    const r = parse(refundBody("pay_001"));
    expect(r.ok).toBe(true);
    if (r.ok && "refund" in r) {
      expect(r.refund).toEqual({
        provider: "fungies",
        sale_id: "pay_001",
        ts: "2025-09-27T19:06:40.000Z",
        amount_unverifiable: true,
      });
    }
  });

  it("falls back to data.order.id when data.payment.id is absent", () => {
    const body = refundBody(undefined);
    (body.data as Record<string, unknown>).order = { id: "order_fallback", createdAt: 1759000000000 };
    (body.data as Record<string, unknown>).payment = undefined;
    const r = parse(body);
    expect(r.ok).toBe(true);
    if (r.ok && "refund" in r) {
      expect(r.refund.sale_id).toBe("order_fallback");
      expect(r.refund.amount_unverifiable).toBe(true);
    }
  });

  it("rejects a refund with missing sale id (400 — refund cannot be linked to a recorded sale)", () => {
    const body = refundBody(undefined);
    (body.data as Record<string, unknown>).order = { createdAt: 1759000000000 };
    const r = parse(body);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toBe("payment_refunded missing data.payment.id — refund cannot be linked to a recorded sale");
    }
  });
});
