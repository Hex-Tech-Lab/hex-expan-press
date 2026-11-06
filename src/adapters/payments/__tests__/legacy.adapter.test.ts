// LegacyPaymentAdapterWrapper money-path tests (audit R01, R04).
// Each test signs a real provider payload and asserts the Universal Language event the
// engine receives: the buyer email that delivery needs, the attribution id, the routing
// decision, and every event of a multi-event delivery. Per-run random secrets: nothing
// credential-shaped is committed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto, { createHash, createHmac } from "node:crypto";
import { LegacyPaymentAdapterWrapper } from "../legacy.adapter.ts";
import { fungiesProvider } from "../../../../payments/src/providers/fungies.ts";
import { payhipProvider } from "../../../../payments/src/providers/payhip.ts";
import { fastspringProvider } from "../../../../payments/src/providers/fastspring.ts";
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

describe("R03: the legacy wrapper books the provider's verified currency", () => {
  it("Fungies USD sale → currency USD on the event (taken from the payload, not stamped)", async () => {
    const { headers, body } = fungiesSale();
    const r = await new LegacyPaymentAdapterWrapper(fungiesProvider).parseAndValidateWebhook(headers, body);
    expect((r as { event: SaleCompletedEvent }).event.currency).toBe("USD");
  });

  it("a provider sale with no currency → refused 400, never booked with a stamped default", async () => {
    const noCurrency = {
      name: "fastspring" as const,
      parseWebhook: () => ({ ok: true as const, sale: { sale_id: "s1", provider: "fastspring" as const, product_id: "p1", amount_usd: 39, ts: "2026-09-28T00:00:00.000Z", email_hash: "h" } }),
    };
    const r = await new LegacyPaymentAdapterWrapper(noCurrency).parseAndValidateWebhook({}, "{}");
    expect(r).toMatchObject({ isValid: false, httpStatus: 400, error: expect.stringContaining("currency") });
  });

  it("a batch with one currency-less sale → the whole delivery is refused 400, no event forwarded", async () => {
    const sale = (id: string, currency?: string) => ({ sale: { sale_id: id, provider: "fastspring" as const, product_id: "p1", amount_usd: 39, ts: "2026-09-28T00:00:00.000Z", email_hash: "h", ...(currency ? { currency } : {}) } });
    const mixed = { name: "fastspring" as const, parseWebhook: () => ({ ok: true as const, batch: [sale("s1", "USD"), sale("s2")] }) };
    const r = await new LegacyPaymentAdapterWrapper(mixed).parseAndValidateWebhook({}, "{}");
    expect(r).toMatchObject({ isValid: false, httpStatus: 400 });
    expect("event" in r).toBe(false);
  });
});

describe("R04: Payhip routing and FastSpring multi-event deliveries", () => {
  const payhipBody = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "paid", id: "tx_1", price: 3900, currency: "USD", email: "b@example.com", items: [{ product_id: "p1" }], date: 1759000000,
      signature: createHash("sha256").update(SECRET, "utf8").digest("hex"),
      ...extra,
    });

  it("Payhip delivery (signature in the body, no signature header) is claimed and books $39", async () => {
    const wrapper = new LegacyPaymentAdapterWrapper(payhipProvider);
    const body = payhipBody();
    expect(wrapper.canHandleWebhook({}, body)).toBe(true);
    const r = await wrapper.parseAndValidateWebhook({}, body);
    expect((r as { event: SaleCompletedEvent }).event.totalCents).toBe(3900);
  });

  it("negative control: Payhip does not claim a body without a signature property, or a non-JSON body", () => {
    const wrapper = new LegacyPaymentAdapterWrapper(payhipProvider);
    expect(wrapper.canHandleWebhook({}, JSON.stringify({ type: "payment_success" }))).toBe(false);
    expect(wrapper.canHandleWebhook({}, "not json")).toBe(false);
  });

  it("FastSpring delivery with two orders → both sales reach the engine, none dropped", async () => {
    const order = (id: string, total: number) => ({
      id: `evt_${id}`, type: "order.completed", created: 1759000000000,
      data: { live: true, id, total, currency: "USD", customer: { email: "b@example.com" }, items: [{ product: "p1" }] },
    });
    const body = JSON.stringify({ events: [order("ord_1", 29), order("ord_2", 39)] });
    const sig = createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("base64");
    const r = await new LegacyPaymentAdapterWrapper(fastspringProvider).parseAndValidateWebhook({ "x-fs-signature": sig }, body);
    expect(r.isValid).toBe(true);
    if (!r.isValid) throw new Error("expected valid");
    const all = [r.event, ...(r.followingEvents ?? [])] as SaleCompletedEvent[];
    expect(all.map((e) => [e.saleId, e.totalCents])).toEqual([["ord_1", 2900], ["ord_2", 3900]]);
  });
});
