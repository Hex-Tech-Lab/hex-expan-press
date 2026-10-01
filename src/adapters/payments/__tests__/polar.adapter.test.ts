// Wave 7.2: Polar refund parsing must distinguish "amount supplied" from "amount
// lost". Polar ALWAYS sends order_id + amount + tax_amount on refunds and supports
// partial refunds, so a refund missing/malforming any of them is a 400 — never an
// amount-less event the ledger would treat as a full reversal.
import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { PolarAdapter, POLAR_WEBHOOK_TOLERANCE_SECONDS } from "../polar.adapter.ts";
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

  // Wave 7.3 safe-integer guards: JSON numbers past Number.MAX_SAFE_INTEGER (or a
  // sum past it) would silently lose cents precision in amount + tax_amount.
  it.each([
    ["amount beyond MAX_SAFE_INTEGER", { amount: Number.MAX_SAFE_INTEGER + 2, tax_amount: 0 }],
    ["amount + tax_amount sum beyond MAX_SAFE_INTEGER", { amount: Number.MAX_SAFE_INTEGER, tax_amount: 1 }],
  ])("rejects a refund with %s → 400 (safe-integer guard)", async (_label, patch) => {
    const res = await parse(refund(patch));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(400);
  });
});

// Sharp-edges audit 2026-10-01: a validly signed delivery must only be trusted
// inside the replay window — otherwise a captured webhook can be replayed
// later. Timestamps are SECONDS; a fixed fake clock makes the boundary
// deterministic (timestamp factories are evaluated AFTER the clock is set).
const FAKE_NOW_SECONDS = 1_700_000_000;

describe("PolarAdapter webhook replay window", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function signedWithTs(payload: string, ts: number | string) {
    const id = "whid_replay_0001";
    const tsStr = ts.toString();
    const sig = crypto.createHmac("sha256", Buffer.from(KEY, "utf8")).update(`${id}.${tsStr}.${payload}`).digest("base64");
    return { "webhook-id": id, "webhook-timestamp": tsStr, "webhook-signature": `v1,${sig}` };
  }

  async function parseWithTs(payload: string, ts: number | string) {
    vi.stubEnv("POLAR_WEBHOOK_SECRET", KEY);
    return new PolarAdapter().parseAndValidateWebhook(signedWithTs(payload, ts), payload);
  }

  it.each<[string, () => number | string]>([
    ["a fresh timestamp", () => FAKE_NOW_SECONDS],
    ["a timestamp exactly at the tolerance boundary (300s old)", () => FAKE_NOW_SECONDS - POLAR_WEBHOOK_TOLERANCE_SECONDS],
    ["a timestamp exactly at the tolerance boundary (300s ahead)", () => FAKE_NOW_SECONDS + POLAR_WEBHOOK_TOLERANCE_SECONDS],
  ])("accepts a signature over %s", async (_label, tsOf) => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW_SECONDS * 1000);
    const res = await parseWithTs(refund({}), tsOf());
    expect(res.isValid).toBe(true);
  });

  it.each<[string, () => number | string]>([
    ["301s old", () => FAKE_NOW_SECONDS - (POLAR_WEBHOOK_TOLERANCE_SECONDS + 1)],
    ["301s in the future", () => FAKE_NOW_SECONDS + POLAR_WEBHOOK_TOLERANCE_SECONDS + 1],
    ["non-numeric", () => "not-a-timestamp"],
  ])("rejects a timestamp %s → 401 outside the N-second tolerance", async (_label, tsOf) => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW_SECONDS * 1000);
    const res = await parseWithTs(refund({}), tsOf());
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(401);
    expect((res as { error?: string }).error).toBe(`Webhook timestamp outside the ${POLAR_WEBHOOK_TOLERANCE_SECONDS}-second tolerance`);
  });
});
