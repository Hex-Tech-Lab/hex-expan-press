// KYC P1: a 100%-off Creem discount is a real $0 order. The orders ledger must accept it as a sale row, not refuse it.
// The write contract is OrderUpsertSchema (payments/src/ledger.ts); amount_usd is min 0, so a zero sale is valid.
import { describe, expect, it } from "vitest";
import { OrderUpsertSchema } from "../src/ledger";

const zeroSale = {
  provider: "creem",
  sale_id: "ord_zero_discount_1",
  product_id: "57596c19-c550-4bde-b17a-e87b86d005c5",
  creator_id: "c0a80101-0000-4000-8000-000000000001",
  amount_usd: 0,
  creator_split_pct: 70,
  creator_split_usd: 0,
  our_split_usd: 0,
  currency: "USD",
  event_type: "sale" as const,
  email_hash: "a".repeat(64),
  attribution_id: null,
  buyer_email_consent: null,
  provider_adjustment_id: null,
  occurred_at: "2026-11-21T12:00:00.000Z",
};

describe("$0 (100%-off) sale in the orders ledger", () => {
  it("accepts a zero-amount sale row", () => {
    expect(OrderUpsertSchema.safeParse(zeroSale).success).toBe(true);
  });

  it("still refuses a negative amount, so the zero allowance is not a general loosening", () => {
    expect(OrderUpsertSchema.safeParse({ ...zeroSale, amount_usd: -0.01 }).success).toBe(false);
  });
});
