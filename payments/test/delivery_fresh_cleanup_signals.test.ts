import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSupabaseAdmin } from "../src/supabase_admin";
import { productionDeps } from "../src/delivery";

// withFreshCleanupSignals: after the request deadline, the cleanup writes (release, confirmation, sent mark, claim message
// read) must still land, because aborting them strands a claim or leaves an accepted email unconfirmed. Each runs on a fresh
// signal. The fake Supabase client records the signal of every table call and rejects a call whose signal has already fired,
// the way postgrest does, so an abort is observable.

type Seen = { table: string; signal?: AbortSignal };
const seen: Seen[] = [];

function fakeClient() {
  return {
    from(table: string) {
      const rec: Seen = { table };
      seen.push(rec);
      const result = { data: [{ state: "sent", fence: 1, link_ciphertext: null }], error: null };
      const chain: Record<string, unknown> = {
        abortSignal(signal: AbortSignal) {
          rec.signal = signal;
          return chain;
        },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          if (rec.signal?.aborted) {
            return Promise.reject(new DOMException("The operation was aborted.", "AbortError")).then(resolve, reject);
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      for (const method of [
        "select", "insert", "update", "delete", "upsert", "eq", "neq", "gt", "gte", "lt", "lte", "is", "in", "or", "order", "limit", "maybeSingle", "single",
      ]) {
        chain[method] = () => chain;
      }
      return chain;
    },
  };
}

vi.mock("../src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn() }));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  seen.length = 0;
  vi.mocked(getSupabaseAdmin).mockResolvedValue(fakeClient() as unknown as Awaited<ReturnType<typeof getSupabaseAdmin>>);
});

describe("withFreshCleanupSignals: cleanup writes land after the request deadline (F-cleanup)", () => {
  it("each cleanup write runs on a fresh, unaborted signal once the request deadline has passed", async () => {
    const deps = productionDeps(Date.now() + 5);
    // The request signal fires at the deadline; wait past it.
    await sleep(25);

    await deps.db.releaseLinkIssued({ saleId: "sale_c1", tokenHash: "h" });
    await deps.db.confirmDelivery({ provider: "paddle", saleId: "sale_c1", tokenHash: "h" });
    await deps.db.markDeliverySent({ provider: "paddle", saleId: "sale_c1", sendKind: "receipt" });
    await deps.db.releaseDeliverySend({ provider: "paddle", saleId: "sale_c1", sendKind: "receipt" });
    await deps.db.readClaimMessage({ provider: "paddle", saleId: "sale_c1", sendKind: "receipt" });

    expect(seen.length).toBeGreaterThanOrEqual(5);
    for (const call of seen) {
      expect(call.signal, `${call.table} call carries a signal`).toBeDefined();
      expect(call.signal!.aborted, `${call.table} call is not cut by the request deadline`).toBe(false);
    }
  });

  it("a read outside the cleanup set still takes the expired request signal", async () => {
    const deps = productionDeps(Date.now() + 5);
    await sleep(25);

    await expect(deps.db.productForAlias("paddle", "11111111-1111-4111-8111-111111111111")).rejects.toThrow();
    expect(seen.some((call) => call.signal?.aborted)).toBe(true);
  });
});
