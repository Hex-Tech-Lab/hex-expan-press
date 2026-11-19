// Supabase calls on the webhook path take the request signal. A query that never answers (a stalled Supabase call) is
// cut at the request budget and rejects, so it cannot hold the response or the sale lock. The sale write is not part
// of this: it is never cut short.
import { describe, it, expect, vi } from "vitest";
import { deliverSaleForWebhook, DeliveryPendingError, productionDeps, saleDeliveryConfirmed } from "../src/delivery";
import { processBillingWebhookUseCase } from "../../src/use_cases/billing/process_billing_webhook";
import type { PaymentProviderPort } from "../../src/domain/payments/payments.port";

const stalled = vi.hoisted(() => {
  /** A query builder that never answers unless its request signal aborts it, the way a stalled Supabase call behaves. */
  function hangingBuilder(): Record<string, unknown> {
    let signal: AbortSignal | undefined;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "gt", "lte", "is", "or", "order", "limit", "maybeSingle", "insert", "upsert", "update", "delete"]) {
      b[m] = () => b;
    }
    b.abortSignal = (s: AbortSignal) => {
      signal = s;
      return b;
    };
    b.then = (_resolve: unknown, reject: (e: unknown) => void) => {
      const fail = () => reject(new Error("aborted by the request signal"));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
      // With no signal the call never settles, like an unbounded stalled call.
    };
    return b;
  }
  return { from: () => hangingBuilder() };
});

vi.mock("../src/supabase_admin.ts", () => ({ getSupabaseAdmin: async () => stalled }));

const BUDGET_MS = 80;
const SLACK_MS = 600; // the query must be cut by the budget, well before a test timeout

describe("Supabase calls on the webhook path take the request budget", () => {
  it("a stalled product lookup is cut at the request budget", async () => {
    const started = Date.now();
    await expect(productionDeps(Date.now() + BUDGET_MS).db.productForAlias("paddle", "alias-1")).rejects.toThrow(/aborted by the request signal/);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS + SLACK_MS);
  }, 2000);

  it("a stalled delivery-confirmation read is cut at the request budget", async () => {
    const started = Date.now();
    await expect(productionDeps(Date.now() + BUDGET_MS).db.deliveryConfirmed("paddle", "sale-1")).rejects.toThrow(/aborted by the request signal/);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS + SLACK_MS);
  }, 2000);

  it("the contended-lock check (saleDeliveryConfirmed) is cut at the request budget", async () => {
    const started = Date.now();
    await expect(saleDeliveryConfirmed("paddle", "sale-1", Date.now() + BUDGET_MS)).rejects.toThrow(/aborted by the request signal/);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS + SLACK_MS);
  }, 2000);

  it("deliverSaleForWebhook maps a stalled pre-send Supabase lookup at budget expiry to DeliveryPendingError (503, F-01)", async () => {
    const started = Date.now();
    const err = await deliverSaleForWebhook({
      provider: "paddle",
      saleId: "stalled-delivery-f01",
      productAlias: "a1",
      buyerEmail: "a@b.co",
      deadlineAt: Date.now() + BUDGET_MS,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryPendingError);
    expect((err as DeliveryPendingError).httpStatus).toBe(503);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS + SLACK_MS);
  }, 2000);

  it("processBillingWebhookUseCase maps a stalled pre-persist readSignal abort to DeliveryPendingError (503, F-01)", async () => {
    const stubAdapter: PaymentProviderPort = {
      providerName: "paddle",
      canHandleWebhook: () => true,
      parseAndValidateWebhook: async () => ({
        isValid: true,
        event: {
          eventType: "sale_completed",
          providerName: "paddle",
          saleId: "stalled-usecase-f01",
          productId: "a1",
          totalCents: 3900,
          currency: "USD",
          buyerEmailHash: "hash",
          buyerEmail: "a@b.co",
          occurredAt: "2026-11-18T12:00:00.000Z",
          providerMode: "live",
          rawPayload: {},
        },
      }),
      createCheckout: async () => {
        throw new Error("unused");
      },
    };
    const started = Date.now();
    const err = await processBillingWebhookUseCase(
      { headers: {}, body: "{}", deadlineAt: Date.now() + BUDGET_MS },
      [stubAdapter],
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryPendingError);
    expect((err as DeliveryPendingError).httpStatus).toBe(503);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS + SLACK_MS);
  }, 2000);
});
