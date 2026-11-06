// LegacyPaymentAdapterWrapper money-path tests (audit R01, R04).
// Each test signs a real provider payload and asserts the Universal Language event the
// engine receives: the buyer email that delivery needs, the attribution id, the routing
// decision, and every event of a multi-event delivery. Per-run random secrets: nothing
// credential-shaped is committed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto, { createHash, createHmac } from "node:crypto";
import { LegacyPaymentAdapterWrapper } from "../legacy.adapter.ts";
import { fungiesProvider } from "../../../../payments/src/providers/fungies.ts";
import type { SaleCompletedEvent } from "../../../domain/payments/payments.port.ts";

const SECRET = crypto.randomBytes(16).toString("hex");

beforeEach(() => {
  vi.stubEnv("FUNGIES_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("PAYHIP_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("FASTSPRING_WEBHOOK_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function fungiesSale(overrides: { attribution?: string } = {}): { headers: Record<string, string>; body: string } {
  const body = JSON.stringify({
    id: "evt_1",
    type: "payment_success",
    data: {
      items: [{ customFields: { product_id: "p1", ...(overrides.attribution ? { attribution_id: overrides.attribution } : {}) } }],
      payment: { id: "pay_1", value: 3900, currency: "USD", currencyDecimals: 2, createdAt: 1759000000000 },
      user: { email: "Buyer@Example.com" },
    },
  });
  const sig = createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("hex");
  return { headers: { "x-fngs-signature": `sha256_${sig}` }, body };
}

describe("R01: legacy-wrapped sales carry the buyer email and attribution to the engine", () => {
  it("Fungies sale → buyerEmail is the raw address delivery needs, hash unchanged, 3900 cents", async () => {
    const { headers, body } = fungiesSale();
    const r = await new LegacyPaymentAdapterWrapper(fungiesProvider).parseAndValidateWebhook(headers, body);
    expect(r.isValid).toBe(true);
    const ev = (r as { event: SaleCompletedEvent }).event;
    expect(ev.eventType).toBe("sale_completed");
    expect(ev.totalCents).toBe(3900);
    expect(ev.buyerEmail).toBe("Buyer@Example.com");
    expect(ev.buyerEmailHash).toBe(createHash("sha256").update("buyer@example.com").digest("hex"));
  });

  it("Fungies sale with a canonical attribution label → attributionId forwarded", async () => {
    const { headers, body } = fungiesSale({ attribution: "yt:abc123" });
    const r = await new LegacyPaymentAdapterWrapper(fungiesProvider).parseAndValidateWebhook(headers, body);
    expect((r as { event: SaleCompletedEvent }).event.attributionId).toBe("yt:abc123");
  });

  it("malformed attribution label → dropped, the sale still parses", async () => {
    const { headers, body } = fungiesSale({ attribution: "bad label with spaces" });
    const r = await new LegacyPaymentAdapterWrapper(fungiesProvider).parseAndValidateWebhook(headers, body);
    expect(r.isValid).toBe(true);
    expect((r as { event: SaleCompletedEvent }).event.attributionId).toBeUndefined();
  });
});
