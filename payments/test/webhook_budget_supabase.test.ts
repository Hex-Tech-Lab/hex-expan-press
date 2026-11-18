// Supabase calls on the webhook path take the request signal. A query that never answers (a stalled Supabase call) is
// cut at the request budget and rejects, so it cannot hold the response or the sale lock. The sale write is not part
// of this: it is never cut short.
import { describe, it, expect, vi } from "vitest";
import { productionDeps, saleDeliveryConfirmed } from "../src/delivery";

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
});
