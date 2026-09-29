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

describe("fungies payment_refunded (reject-all — no refund-amount field is mapped)", () => {
  it("rejects a full-shape refund event with 422 manual review", () => {
    const r = parse(refundBody("pay_001"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.error).toBe("fungies refund amount not mapped — full vs partial cannot be verified; manual review required");
    }
  });

  it("rejects a refund event even when the sale id is present in data.order", () => {
    const body = refundBody("pay_002");
    (body.data as Record<string, unknown>).order = { id: "order_fallback", createdAt: 1759000000000 };
    (body.data as Record<string, unknown>).payment = undefined;
    const r = parse(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it("rejects a malformed refund with missing sale id the same way (422, not recorded)", () => {
    const r = parse(refundBody(undefined));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.error).toContain("manual review required");
    }
  });
});
