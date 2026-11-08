// Audit R02: raw provider amounts must be real numbers before they become money.
// Number(undefined) is NaN, which skipped the partial-refund guard and booked a partial refund
// as a full reversal; Number(null) and Number("") are 0, which booked a $0 sale.
// Each case asserts the money outcome: refund emitted or refused (and with which status), and
// the amount a sale books. Per-run random secret: nothing credential-shaped is committed.
import { describe, it, expect } from "vitest";
import crypto, { createHash, createHmac } from "node:crypto";
import { payhipProvider } from "../src/providers/payhip.ts";
import { fastspringProvider } from "../src/providers/fastspring.ts";
import { fungiesProvider } from "../src/providers/fungies.ts";
import { lemonsqueezyProvider } from "../src/providers/lemonsqueezy.ts";
import { strictAmount, type ParseResult } from "../src/provider.ts";

const SECRET = crypto.randomBytes(16).toString("hex");

function payhip(body: Record<string, unknown>): ParseResult {
  const signature = createHash("sha256").update(SECRET, "utf8").digest("hex");
  return payhipProvider.parseWebhook({}, Buffer.from(JSON.stringify({ ...body, signature })), SECRET);
}

function fastspring(events: Record<string, unknown>[]): ParseResult {
  const raw = Buffer.from(JSON.stringify({ events }));
  const sig = createHmac("sha256", SECRET).update(raw).digest("base64");
  return fastspringProvider.parseWebhook({ "x-fs-signature": sig }, raw, SECRET);
}

function fungies(body: Record<string, unknown>): ParseResult {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
  return fungiesProvider.parseWebhook({ "x-fngs-signature": `sha256_${sig}` }, raw, SECRET);
}

function lemonsqueezy(body: Record<string, unknown>): ParseResult {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
  return lemonsqueezyProvider.parseWebhook({ "x-signature": sig }, raw, SECRET);
}

const saleAmount = (r: ParseResult): number | undefined => (r.ok && "sale" in r ? r.sale.amount_usd : undefined);
const status = (r: ParseResult): number | undefined => (r.ok ? undefined : r.status);

const PAYHIP_REFUND = { type: "refunded", id: "tx_1", price: 3900, amount_refunded: 3900, currency: "USD", date_refunded: 1759000000 };
const PAYHIP_SALE = { type: "paid", id: "tx_1", price: 3900, currency: "USD", email: "b@example.com", items: [{ product_id: "p1" }], date: 1759000000 };

describe("strictAmount", () => {
  it("accepts finite numbers and numeric strings, rejects absent, null, blank, booleans and NaN", () => {
    expect(strictAmount(3900)).toBe(3900);
    expect(strictAmount("29.00")).toBe(29);
    expect(strictAmount(0)).toBe(0);
    for (const bad of [undefined, null, "", "  ", "abc", true, false, NaN, Infinity, {}, []]) {
      expect(strictAmount(bad)).toBeUndefined();
    }
  });

  it("accepts only plain decimal strings: hex, exponent and thousands separators are refused, not reinterpreted", () => {
    expect(strictAmount("12")).toBe(12);
    expect(strictAmount("12.50")).toBe(12.5);
    expect(strictAmount("0")).toBe(0);
    expect(strictAmount("-5")).toBe(-5);
    // "0x10" would book $0.16 as 16 minor units, "1e3" would book 1000.
    for (const bad of ["0x10", "1e3", "1E3", "1,000", " ", "NaN", "Infinity", "+12", "12.", ".5", " 12", "12 ", "0b11", "0o7", null, undefined]) {
      expect(strictAmount(bad)).toBeUndefined();
    }
  });

  it("a hex-encoded price on a sale is refused instead of booked", () => {
    expect(saleAmount(payhip({ ...PAYHIP_SALE, price: "0x10" }))).toBeUndefined();
    expect(saleAmount(payhip({ ...PAYHIP_SALE, price: "1e3" }))).toBeUndefined();
  });
});

describe("payhip refunds: the original price must be present to prove a full reversal", () => {
  it("price omitted → refused 422, no refund emitted", () => {
    const body = { ...PAYHIP_REFUND };
    delete (body as { price?: unknown }).price;
    expect(status(payhip(body))).toBe(422);
  });

  it("price null → refused 422", () => {
    expect(status(payhip({ ...PAYHIP_REFUND, price: null }))).toBe(422);
  });

  it("amount_refunded null → refused 400 (not coerced to a $0 refund)", () => {
    expect(status(payhip({ ...PAYHIP_REFUND, amount_refunded: null }))).toBe(400);
  });

  it("partial refund → still refused 422", () => {
    expect(status(payhip({ ...PAYHIP_REFUND, amount_refunded: 1000 }))).toBe(422);
  });

  it("control: full refund with price present → refund emitted", () => {
    const r = payhip(PAYHIP_REFUND);
    expect(r.ok && "refund" in r ? r.refund.sale_id : undefined).toBe("tx_1");
  });
});

describe("payhip sales: a missing price never books $0", () => {
  it.each([null, "", undefined])("price %j → refused 400", (price) => {
    expect(status(payhip({ ...PAYHIP_SALE, price }))).toBe(400);
  });

  it("control: price 3900 → books $39", () => {
    expect(saleAmount(payhip(PAYHIP_SALE))).toBe(39);
  });
});

const FS_RETURN = {
  id: "e1",
  type: "return.created",
  created: 1759000000000,
  data: { live: true, totalReturn: 29, original: { order: "ord_1", total: 29 } },
};
const FS_ORDER = {
  id: "e2",
  type: "order.completed",
  created: 1759000000000,
  data: { live: true, id: "ord_1", total: 29, currency: "USD", customer: { email: "b@example.com" }, items: [{ product: "p1" }] },
};

describe("fastspring returns: both totals must be present to prove a full reversal", () => {
  it("original.total omitted → refused 422", () => {
    const evt = { ...FS_RETURN, data: { ...FS_RETURN.data, original: { order: "ord_1" } } };
    expect(status(fastspring([evt]))).toBe(422);
  });

  it("totalReturn null → refused 422", () => {
    const evt = { ...FS_RETURN, data: { ...FS_RETURN.data, totalReturn: null } };
    expect(status(fastspring([evt]))).toBe(422);
  });

  it("partial return → still refused 422", () => {
    const evt = { ...FS_RETURN, data: { ...FS_RETURN.data, totalReturn: 10 } };
    expect(status(fastspring([evt]))).toBe(422);
  });

  it("over-return (totalReturn > originalTotal) → refused 422", () => {
    const evt = { ...FS_RETURN, data: { ...FS_RETURN.data, totalReturn: 50 } };
    expect(status(fastspring([evt]))).toBe(422);
  });

  it("control: full return → refund emitted", () => {
    const r = fastspring([FS_RETURN]);
    expect(r.ok && "refund" in r ? r.refund.sale_id : undefined).toBe("ord_1");
  });
});

describe("fastspring, fungies, lemonsqueezy sales: null or blank totals never book $0", () => {
  it.each([null, ""])("fastspring data.total %j → refused 400", (total) => {
    expect(status(fastspring([{ ...FS_ORDER, data: { ...FS_ORDER.data, total } }]))).toBe(400);
  });

  it("control: fastspring total 29 → books $29", () => {
    expect(saleAmount(fastspring([FS_ORDER]))).toBe(29);
  });

  const fungiesSale = (value: unknown) => ({
    id: "evt_1",
    type: "payment_success",
    data: {
      items: [{ customFields: { product_id: "p1" } }],
      payment: { id: "pay_1", value, currency: "USD", currencyDecimals: 2, createdAt: 1759000000000 },
      user: { email: "b@example.com" },
    },
  });

  it("fungies payment.value \"\" → refused 400", () => {
    expect(status(fungies(fungiesSale("")))).toBe(400);
  });

  it("control: fungies payment.value 3900 → books $39", () => {
    expect(saleAmount(fungies(fungiesSale(3900)))).toBe(39);
  });

  const lsSale = (total: unknown) => ({
    meta: { event_name: "order_created", custom_data: { product_id: "p1" } },
    data: { id: "ls_1", attributes: { total, currency: "USD", user_email: "b@example.com", created_at: "2026-09-28T00:00:00.000Z" } },
  });

  it.each([null, ""])("lemonsqueezy total %j → refused 400", (total) => {
    expect(status(lemonsqueezy(lsSale(total)))).toBe(400);
  });

  it("control: lemonsqueezy total 3900 → books $39", () => {
    expect(saleAmount(lemonsqueezy(lsSale(3900)))).toBe(39);
  });
});
