// F-09 provider mode for Creem: read from Creem's own `mode` fields, never defaulted. Missing or conflicting
// values yield no mode, and the use case refuses the sale.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { CreemAdapter, creemProviderMode } from "../creem.adapter.ts";

const SECRET = "whsec_creem_provider_mode_fixture";

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

function checkoutCompleted(objectMode: string | undefined, orderMode: string | undefined): string {
  const object: Record<string, unknown> = {
    id: "ch_mode_1",
    metadata: { order_ref: "order-ref-mode" },
    order: { id: "ord_mode_1", status: "paid", amount: 1900, amount_paid: 1900, currency: "usd", product: "prod_mode_1", ...(orderMode !== undefined ? { mode: orderMode } : {}) },
    customer: { email: "buyer@example.com" },
    ...(objectMode !== undefined ? { mode: objectMode } : {}),
  };
  return JSON.stringify({ id: "evt_mode_1", eventType: "checkout.completed", created_at: 1728734325927, object });
}

function headersFor(body: string): Record<string, string> {
  return { "creem-signature": sign(body), "content-type": "application/json" };
}

describe("creemProviderMode", () => {
  it.each([
    ["live", undefined, "live"],
    [undefined, "live", "live"],
    ["live", "live", "live"],
    ["test", undefined, "sandbox"],
    ["test", "test", "sandbox"],
  ] as const)("object.mode %s / order.mode %s → %s", (objectMode, orderMode, expected) => {
    expect(creemProviderMode({ mode: objectMode, order: { mode: orderMode } })).toBe(expected);
  });

  it("no mode field anywhere → undefined (refused downstream)", () => {
    expect(creemProviderMode({ order: {} })).toBeUndefined();
  });

  it("conflicting object and order modes → undefined (refused downstream)", () => {
    expect(creemProviderMode({ mode: "live", order: { mode: "test" } })).toBeUndefined();
  });

  it("an unknown mode string → undefined", () => {
    expect(creemProviderMode({ mode: "staging", order: {} })).toBeUndefined();
  });
});

describe("CreemAdapter sale event carries providerMode", () => {
  beforeEach(() => {
    vi.stubEnv("CREEM_WEBHOOK_SECRET", SECRET);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a live checkout yields a live sale", async () => {
    const body = checkoutCompleted("live", "live");
    const res = await new CreemAdapter({ accept: false }).parseAndValidateWebhook(headersFor(body), body);
    expect(res).toMatchObject({ isValid: true, event: { eventType: "sale_completed", providerMode: "live" } });
  });

  it("a checkout with no mode field yields a sale with no mode (the use case refuses it)", async () => {
    const body = checkoutCompleted(undefined, undefined);
    const res = await new CreemAdapter({ accept: false }).parseAndValidateWebhook(headersFor(body), body);
    expect(res.isValid).toBe(true);
    expect(res).toMatchObject({ event: { eventType: "sale_completed" } });
    expect((res as { event: { providerMode?: unknown } }).event.providerMode).toBeUndefined();
  });

  it("a test-mode checkout passes only through the open test gate, and then maps to sandbox", async () => {
    const body = checkoutCompleted("test", "test");
    const gate = { accept: true, databaseRef: "branchref", supabaseUrl: "https://branchref.supabase.co" };
    const res = await new CreemAdapter(gate).parseAndValidateWebhook(headersFor(body), body);
    expect(res).toMatchObject({ isValid: true, event: { providerMode: "sandbox" } });
  });
});
