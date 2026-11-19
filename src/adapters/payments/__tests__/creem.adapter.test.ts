import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { CreemAdapter } from "../creem.adapter.ts";

const SECRET = "whsec_test_creem_fixture";

function sign(body: string, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function checkoutCompleted(overrides: Record<string, unknown> = {}, orderOverrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "evt_test_1",
    eventType: "checkout.completed",
    created_at: 1728734325927,
    object: {
      id: "ch_test_1",
      mode: "live",
      metadata: { order_ref: "order-ref-123" },
      order: {
        id: "ord_test_1",
        status: "paid",
        amount: 1900,
        amount_paid: 1900,
        currency: "usd",
        product: "prod_test_1",
        mode: "live",
        ...orderOverrides,
      },
      customer: { email: "buyer@example.com" },
      ...overrides,
    },
  });
}

function headersFor(body: string, secret = SECRET): Record<string, string> {
  return { "creem-signature": sign(body, secret), "content-type": "application/json" };
}

describe("CreemAdapter", () => {
  const adapter = new CreemAdapter();
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevSecret = process.env.CREEM_WEBHOOK_SECRET;
    process.env.CREEM_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.CREEM_WEBHOOK_SECRET;
    else process.env.CREEM_WEBHOOK_SECRET = prevSecret;
  });

  it("claims only requests that carry the creem-signature header", () => {
    expect(adapter.canHandleWebhook({ "creem-signature": "abc" })).toBe(true);
    expect(adapter.canHandleWebhook({ "webhook-signature": "abc" })).toBe(false);
  });

  it("returns 500 when the webhook secret is not configured", async () => {
    delete process.env.CREEM_WEBHOOK_SECRET;
    const body = checkoutCompleted();
    const r = await adapter.parseAndValidateWebhook(headersFor(body), body);
    expect(r).toMatchObject({ isValid: false, httpStatus: 500 });
  });

  it("returns 401 for a bad signature (verified by the SDK, not by us)", async () => {
    const body = checkoutCompleted();
    const r = await adapter.parseAndValidateWebhook(headersFor(body, "wrong-secret"), body);
    expect(r).toMatchObject({ isValid: false, httpStatus: 401 });
  });

  it("maps a paid live checkout.completed to sale_completed with our reference", async () => {
    const body = checkoutCompleted();
    const r = await adapter.parseAndValidateWebhook(headersFor(body), body);
    expect(r.isValid).toBe(true);
    if (!r.isValid) return;
    expect(r.event).toMatchObject({
      eventType: "sale_completed",
      providerName: "creem",
      saleId: "ord_test_1",
      productId: "prod_test_1",
      totalCents: 1900,
      currency: "USD",
      attributionId: "order-ref-123",
      buyerEmail: "buyer@example.com",
    });
    if (r.event.eventType === "sale_completed") {
      expect(r.event.buyerEmailHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.event.occurredAt).toBe(new Date(1728734325927).toISOString());
    }
  });

  it("accepts and books a paid checkout.completed whose buyer email is not RFC-valid (no sale is refused on email format)", async () => {
    const oddEmail = "buyer name@example.com";
    const body = checkoutCompleted({ customer: { email: oddEmail } });
    const r = await adapter.parseAndValidateWebhook(headersFor(body), body);
    expect(r.isValid).toBe(true);
    if (!r.isValid) return;
    expect(r.event).toMatchObject({
      eventType: "sale_completed",
      providerName: "creem",
      saleId: "ord_test_1",
      buyerEmail: oddEmail,
    });
    if (r.event.eventType === "sale_completed") {
      expect(r.event.buyerEmailHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("refuses test-mode deliveries when the test gate is closed (default)", async () => {
    const closed = new CreemAdapter({ accept: false, databaseRef: "test-branch-ref", supabaseUrl: "https://test-branch-ref.supabase.co" });
    const body = checkoutCompleted({ mode: "test" }, { mode: "test" });
    const r = await closed.parseAndValidateWebhook(headersFor(body), body);
    expect(r).toMatchObject({ isValid: false, httpStatus: 400 });
  });

  it("accepts test-mode deliveries only when the flag is on AND SUPABASE_URL is the configured test branch", async () => {
    const open = new CreemAdapter({ accept: true, databaseRef: "test-branch-ref", supabaseUrl: "https://test-branch-ref.supabase.co" });
    const body = checkoutCompleted({ mode: "test" }, { mode: "test" });
    const r = await open.parseAndValidateWebhook(headersFor(body), body);
    expect(r).toMatchObject({ isValid: true, event: { eventType: "sale_completed", providerName: "creem" } });
  });

  it("refuses test-mode when the flag is on but the database is production (fail closed)", async () => {
    const wrongDb = new CreemAdapter({ accept: true, databaseRef: "test-branch-ref", supabaseUrl: "https://hywqftbcjhfjegypzpzd.supabase.co" });
    const body = checkoutCompleted({ mode: "test" }, { mode: "test" });
    const r = await wrongDb.parseAndValidateWebhook(headersFor(body), body);
    expect(r).toMatchObject({ isValid: false, httpStatus: 400 });
  });

  it.each([
    "https://test-branch-ref.supabase.co.evil.example",
    "https://evil-test-branch-ref.supabase.co",
    "https://xtest-branch-ref.supabase.co",
    "not a url",
  ])("refuses test-mode when the database ref only appears inside another host (%s)", async (supabaseUrl) => {
    const lookalike = new CreemAdapter({ accept: true, databaseRef: "test-branch-ref", supabaseUrl });
    const body = checkoutCompleted({ mode: "test" }, { mode: "test" });
    const r = await lookalike.parseAndValidateWebhook(headersFor(body), body);
    expect(r).toMatchObject({ isValid: false, httpStatus: 400 });
  });

  it("refuses test-mode when no test database ref is configured, even with the flag on", async () => {
    const noRef = new CreemAdapter({ accept: true, databaseRef: "", supabaseUrl: "https://anything.supabase.co" });
    const body = checkoutCompleted({ mode: "test" }, { mode: "test" });
    const r = await noRef.parseAndValidateWebhook(headersFor(body), body);
    expect(r).toMatchObject({ isValid: false, httpStatus: 400 });
  });

  it("never changes live-mode handling, whatever the test gate says", async () => {
    const open = new CreemAdapter({ accept: true, databaseRef: "test-branch-ref", supabaseUrl: "https://test-branch-ref.supabase.co" });
    const body = checkoutCompleted();
    const r = await open.parseAndValidateWebhook(headersFor(body), body);
    expect(r).toMatchObject({ isValid: true, event: { eventType: "sale_completed" } });
  });

  it("ignores a checkout that is not paid", async () => {
    const body = checkoutCompleted({}, { status: "pending" });
    const r = await adapter.parseAndValidateWebhook(headersFor(body), body);
    expect(r).toMatchObject({ isValid: true, event: { eventType: "ignored" } });
  });

  it("refuses refund and dispute events with 422 so they reach manual review, never silently ignored", async () => {
    for (const eventType of ["refund.created", "dispute.created"]) {
      const body = JSON.stringify({ id: "evt_x", eventType, created_at: 1, object: {} });
      const r = await adapter.parseAndValidateWebhook(headersFor(body), body);
      expect(r).toMatchObject({ isValid: false, httpStatus: 422 });
    }
  });

  it("returns 400 for a verified body that is not checkout.completed-shaped", async () => {
    const body = JSON.stringify({ id: "evt_bad", eventType: "checkout.completed", created_at: 1, object: { nope: true } });
    const r = await adapter.parseAndValidateWebhook(headersFor(body), body);
    expect(r).toMatchObject({ isValid: false, httpStatus: 400 });
  });

  it("returns 400 when a validly signed body is not valid JSON (SyntaxError branch)", async () => {
    const body = "{not-valid-json";
    const r = await adapter.parseAndValidateWebhook(headersFor(body), body);
    expect(r).toMatchObject({
      isValid: false,
      httpStatus: 400,
      error: "Schema validation failed: body is not valid JSON",
    });
  });

  it.each([
    ["string", "2026-11-16T00:00:00Z"],
    ["missing", undefined],
  ])("returns 400 when createdAt is not a number (%s)", async (_label, createdAt) => {
    const parsed = JSON.parse(checkoutCompleted()) as Record<string, unknown>;
    if (createdAt === undefined) delete parsed.created_at;
    else parsed.created_at = createdAt;
    const body = JSON.stringify(parsed);
    const r = await adapter.parseAndValidateWebhook(headersFor(body), body);
    expect(r).toMatchObject({
      isValid: false,
      httpStatus: 400,
      error: "Creem delivery has no event time",
    });
  });

  it("refuses to create checkouts on the buy path (product_rails serves static links)", async () => {
    await expect(adapter.createCheckout({ productId: "p", userId: "u", buyerEmail: "a@b.co", successUrl: "https://x.y" })).rejects.toThrow();
  });
});
