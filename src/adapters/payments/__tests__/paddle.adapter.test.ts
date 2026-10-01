// Paddle webhook verifier regression tests (ADR-0050 hardening): timestamp
// freshness is enforced BEFORE HMAC verification (5-minute tolerance,
// fail-closed), h1 must be exactly 64 hex chars, and multiple h1 values
// (secret rotation) are accepted when ANY valid-format one matches.
// Per-run random secret: nothing credential-shaped is committed.
import { describe, it, expect, afterEach, vi } from "vitest";
import crypto, { createHash } from "node:crypto";
import { PaddleAdapter, PADDLE_WEBHOOK_TOLERANCE_SECONDS } from "../paddle.adapter.ts";
import type { SaleCompletedEvent } from "../../../domain/payments/payments.port.ts";

const SECRET = crypto.randomBytes(16).toString("hex");

const hmacFor = (ts: string, body: string): string =>
  crypto.createHmac("sha256", Buffer.from(SECRET, "utf8")).update(`${ts}:${body}`, "utf8").digest("hex");

const validBody = (): string =>
  JSON.stringify({
    event_type: "transaction.completed",
    data: {
      id: "txn_test_0001",
      currency_code: "USD",
      details: { totals: { total: "1000" } },
      custom_data: { product_id: "test_product_v1", email: "buyer@example.com" },
      changed_at: new Date().toISOString(),
    },
  });

const headersFor = (sig: string): Record<string, string> => ({ "paddle-signature": sig });

async function parse(body: string, sig: string, secret?: string): Promise<Awaited<ReturnType<PaddleAdapter["parseAndValidateWebhook"]>>> {
  vi.stubEnv("PADDLE_WEBHOOK_SECRET", secret ?? SECRET);
  return new PaddleAdapter().parseAndValidateWebhook(headersFor(sig), body);
}

function freshSig(body: string): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  return `ts=${ts};h1=${hmacFor(ts, body)}`;
}

describe("PaddleAdapter webhook verification (tolerance + h1 format)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("PADDLE_WEBHOOK_TOLERANCE_SECONDS is 300", () => {
    expect(PADDLE_WEBHOOK_TOLERANCE_SECONDS).toBe(300);
  });

  it("a valid transaction.completed maps the sale fields", async () => {
    const body = validBody();
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(true);
    const event = (res as { event: SaleCompletedEvent }).event;
    expect(event.eventType).toBe("sale_completed");
    expect(event.providerName).toBe("paddle");
    expect(event.saleId).toBe("txn_test_0001");
    expect(event.productId).toBe("test_product_v1");
    expect(event.totalCents).toBe(1000);
    expect(event.currency).toBe("USD");
    expect(event.buyerEmailHash).toBe(createHash("sha256").update("buyer@example.com").digest("hex"));
  });

  it.each([
    ["301s old", () => (Math.floor(Date.now() / 1000) - 301).toString()],
    ["301s future", () => (Math.floor(Date.now() / 1000) + 301).toString()],
    ["non-integer (decimal)", () => `${Math.floor(Date.now() / 1000)}.5`],
    ["non-integer (junk)", () => "not-a-number"],
  ])("ts %s → 401 outside the 5-minute tolerance", async (_label, ts) => {
    const body = validBody();
    const res = await parse(body, `ts=${ts()};h1=${hmacFor("0", body)}`);
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(401);
    expect((res as { error?: string }).error).toBe("Webhook timestamp outside the 5-minute tolerance");
  });

  it("a wrong h1 → 401 Invalid Paddle signature", async () => {
    const body = validBody();
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await parse(body, `ts=${ts};h1=${"a".repeat(64)}`);
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(401);
    expect((res as { error?: string }).error).toBe("Invalid Paddle signature");
  });

  it("a valid h1 with a junk 'z' suffix → 401 (64-hex format gate, no silent truncation)", async () => {
    const body = validBody();
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await parse(body, `ts=${ts};h1=${hmacFor(ts, body)}z`);
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(401);
  });

  it("an h1 shorter than 64 hex chars → 401", async () => {
    const body = validBody();
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await parse(body, `ts=${ts};h1=${hmacFor(ts, body).slice(0, 63)}`);
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(401);
  });

  it("two h1 values where the SECOND is correct → valid (secret rotation)", async () => {
    const body = validBody();
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await parse(body, `ts=${ts};h1=${"b".repeat(64)};h1=${hmacFor(ts, body)}`);
    expect(res.isValid).toBe(true);
    expect((res as { event: SaleCompletedEvent }).event.eventType).toBe("sale_completed");
  });

  it("missing h1 entirely → 401 malformed header", async () => {
    const body = validBody();
    const res = await parse(body, `ts=${Math.floor(Date.now() / 1000)}`);
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(401);
  });

  it("missing PADDLE_WEBHOOK_SECRET → 500 (never verify against an empty secret)", async () => {
    const body = validBody();
    const res = await parse(body, freshSig(body), "");
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(500);
  });

  it("a non-transaction.completed event verifies but is NOT a sale (ignored event)", async () => {
    const body = JSON.stringify({
      event_type: "order.created",
      data: { id: "txn_test_0002", custom_data: { product_id: "test_product_v1", email: "buyer@example.com" } },
    });
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(true);
    const event = (res as { event: { eventType: string } }).event;
    expect(event.eventType).not.toBe("sale_completed");
    expect(event.eventType).toBe("ignored");
  });
});
