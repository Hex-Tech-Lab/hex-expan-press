import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSupabaseAdmin } from "../src/supabase_admin";
import { resolveProductByAlias } from "../src/webhook_core";

// Records the OR filter the product lookup sends. A Paddle ID must only be matchable by a Paddle sale.
const seen: string[] = [];
const row = { store_product_id: "duane_retirement_playbook_v1", currency: "USD", provider: "paddle", creators: { handle: "duane" } };

function fakeClient() {
  return {
    from(table: string) {
      if (table !== "products") throw new Error(`unexpected table ${table}`);
      const chain = {
        select: () => chain,
        eq: () => chain,
        or: (filter: string) => {
          seen.push(filter);
          return chain;
        },
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return chain;
    },
  };
}

vi.mock("../src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn() }));

const ALIAS = "shared-paddle-id-123";

beforeEach(() => {
  seen.length = 0;
  vi.mocked(getSupabaseAdmin).mockResolvedValue(fakeClient() as unknown as Awaited<ReturnType<typeof getSupabaseAdmin>>);
});

import { WebhookValidationError } from "../../src/domain/webhook/webhook_errors.ts";

describe("resolveProductByAlias: a row that exists but cannot sell is retryable (503)", () => {
  it.each([
    ["a missing store_product_id", { ...row, store_product_id: null }],
    ["a missing creator handle", { ...row, creators: null }],
    ["an empty creator handle", { ...row, creators: { handle: "" } }],
    ["a creators row without a handle", { ...row, creators: {} }],
  ])("%s on an existing row throws a 503, never returns null", async (_label, incomplete) => {
    vi.mocked(getSupabaseAdmin).mockResolvedValue({
      from: () => {
        const chain = { select: () => chain, or: () => chain, eq: () => chain, maybeSingle: async () => ({ data: incomplete, error: null }) };
        return chain;
      },
    } as unknown as Awaited<ReturnType<typeof getSupabaseAdmin>>);
    const err = await resolveProductByAlias(ALIAS, "paddle").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookValidationError);
    expect((err as WebhookValidationError).httpStatus).toBe(503);
  });

  it("an unregistered provider on an existing row throws a 503, never returns null", async () => {
    const unregistered = { ...row, provider: "polar" };
    vi.mocked(getSupabaseAdmin).mockResolvedValue({
      from: () => {
        const chain = { select: () => chain, or: () => chain, eq: () => chain, maybeSingle: async () => ({ data: unregistered, error: null }) };
        return chain;
      },
    } as unknown as Awaited<ReturnType<typeof getSupabaseAdmin>>);
    const err = await resolveProductByAlias(ALIAS, "polar").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookValidationError);
    expect((err as WebhookValidationError).httpStatus).toBe(503);
  });
});

describe("resolveProductByAlias: paddle_product_id is matched only for Paddle sales", () => {
  it("a Paddle sale can match paddle_product_id", async () => {
    await resolveProductByAlias(ALIAS, "paddle");
    expect(seen[0]).toContain(`paddle_product_id.eq.${ALIAS}`);
  });

  it("a Polar sale cannot match paddle_product_id", async () => {
    await resolveProductByAlias(ALIAS, "polar");
    expect(seen[0]).not.toContain("paddle_product_id");
    expect(seen[0]).toContain(`store_product_id.eq.${ALIAS}`);
  });

  it("a Polar sale with a Paddle-only alias resolves to nothing", async () => {
    // The row the fake returns is found only through the paddle_product_id filter, which a Polar sale never sends.
    // Simulate the database: the store_product_id clause misses, so the lookup must not match the row.
    let lastFilter = "";
    const db = {
      from: () => {
        const chain = {
          select: () => chain,
          or: (filter: string) => {
            lastFilter = filter;
            seen.push(filter);
            return chain;
          },
          eq: () => chain,
          maybeSingle: async () => ({ data: lastFilter.includes("paddle_product_id") ? row : null, error: null }),
        };
        return chain;
      },
    };
    vi.mocked(getSupabaseAdmin).mockResolvedValue(db as unknown as Awaited<ReturnType<typeof getSupabaseAdmin>>);
    expect(await resolveProductByAlias(ALIAS, "polar")).toBeNull();
  });
});

describe("resolveProductByAlias: input validation, UUID arm, and DB errors", () => {
  it("returns null without querying DB when alias is non-string or fails PRODUCT_ALIAS_RE", async () => {
    vi.mocked(getSupabaseAdmin).mockClear();
    expect(await resolveProductByAlias(null as unknown as string, "paddle")).toBeNull();
    expect(await resolveProductByAlias("bad.alias,or", "paddle")).toBeNull();
    expect(await resolveProductByAlias("", "paddle")).toBeNull();
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it("throws fail-closed when Supabase admin client is unavailable", async () => {
    vi.mocked(getSupabaseAdmin).mockResolvedValueOnce(null);
    await expect(resolveProductByAlias(ALIAS, "paddle")).rejects.toThrow(
      "Supabase admin client unavailable — product resolution cannot run (fail closed)",
    );
  });

  it("includes the id.eq.<uuid> arm when alias is a valid UUID", async () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const resolved = await resolveProductByAlias(uuid, "paddle");
    expect(seen[0]).toContain(`id.eq.${uuid}`);
    expect(resolved?.productId).toBe("duane_retirement_playbook_v1");
  });

  it("throws when the Supabase product lookup returns an error", async () => {
    vi.mocked(getSupabaseAdmin).mockResolvedValueOnce({
      from: () => {
        const chain = {
          select: () => chain,
          or: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: null, error: { message: "db timeout" } }),
        };
        return chain;
      },
    } as unknown as Awaited<ReturnType<typeof getSupabaseAdmin>>);
    await expect(resolveProductByAlias(ALIAS, "paddle")).rejects.toThrow(
      `webhook: product lookup failed for '${ALIAS}': db timeout`,
    );
  });
});
