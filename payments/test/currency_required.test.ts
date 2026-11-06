// Audit R03: a sale with no currency must never reach the ledger. An empty currency skipped the
// isAllowedCurrency gate and the legacy wrapper then stamped it "USD", booking an unknown-currency
// charge as dollars. Each case asserts the outcome: refused with 400, or (control) booked.
// Per-run random secret: nothing credential-shaped is committed.
import { describe, it, expect } from "vitest";
import crypto, { createHash, createHmac } from "node:crypto";
import { payhipProvider } from "../src/providers/payhip.ts";
import { fastspringProvider } from "../src/providers/fastspring.ts";
import { fungiesProvider } from "../src/providers/fungies.ts";
import { lemonsqueezyProvider } from "../src/providers/lemonsqueezy.ts";
import type { ParseResult } from "../src/provider.ts";

const SECRET = crypto.randomBytes(16).toString("hex");
const hex = (raw: Buffer) => createHmac("sha256", SECRET).update(raw).digest("hex");

const parsers: Record<string, (currency: unknown) => ParseResult> = {
  fungies: (currency) => {
    const raw = Buffer.from(JSON.stringify({
      id: "evt_1",
      type: "payment_success",
      data: {
        items: [{ customFields: { product_id: "p1" } }],
        payment: { id: "pay_1", value: 3900, currency, currencyDecimals: 2, createdAt: 1759000000000 },
        user: { email: "b@example.com" },
      },
    }));
    return fungiesProvider.parseWebhook({ "x-fngs-signature": `sha256_${hex(raw)}` }, raw, SECRET);
  },
  payhip: (currency) => {
    const signature = createHash("sha256").update(SECRET, "utf8").digest("hex");
    const raw = Buffer.from(JSON.stringify({
      type: "paid", id: "tx_1", price: 3900, currency, email: "b@example.com", items: [{ product_id: "p1" }], date: 1759000000, signature,
    }));
    return payhipProvider.parseWebhook({}, raw, SECRET);
  },
  fastspring: (currency) => {
    const raw = Buffer.from(JSON.stringify({ events: [{
      id: "e1", type: "order.completed", created: 1759000000000,
      data: { live: true, id: "ord_1", total: 39, currency, customer: { email: "b@example.com" }, items: [{ product: "p1" }] },
    }] }));
    return fastspringProvider.parseWebhook({ "x-fs-signature": createHmac("sha256", SECRET).update(raw).digest("base64") }, raw, SECRET);
  },
  lemonsqueezy: (currency) => {
    const raw = Buffer.from(JSON.stringify({
      meta: { event_name: "order_created", custom_data: { product_id: "p1" } },
      data: { id: "ls_1", attributes: { total: 3900, currency, user_email: "b@example.com", created_at: "2026-09-28T00:00:00.000Z" } },
    }));
    return lemonsqueezyProvider.parseWebhook({ "x-signature": hex(raw) }, raw, SECRET);
  },
};

describe.each(Object.keys(parsers))("%s sale currency", (name) => {
  const parse = parsers[name]!;

  it.each([["omitted", undefined], ["null", null], ["blank", ""]])("currency %s → refused 400, no sale", (_l, currency) => {
    const r = parse(currency);
    expect(r.ok).toBe(false);
    expect(r.ok ? undefined : r.status).toBe(400);
  });

  it("control: USD → sale booked at $39 with currency USD", () => {
    const r = parse("usd");
    expect(r.ok && "sale" in r ? { amount: r.sale.amount_usd, currency: r.sale.currency } : r).toEqual({ amount: 39, currency: "USD" });
  });
});
