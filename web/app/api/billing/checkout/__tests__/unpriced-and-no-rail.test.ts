// Fail-closed checkout contracts for a product with no price (409) and a product with no active payment rail (503 + Retry-After).
// Neither path may write an order or label a provider: the router is never asked to pick a rail on either path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { MatrixRouter } from "../../../../../../src/infrastructure/matrix_router/matrix_router";
import { GLOBAL } from "../../../../../../payments/src/settings_registry";

const adminModule = vi.hoisted(() => ({
  mockAdminClient: null as unknown,
}));

vi.mock("../../../../../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => adminModule.mockAdminClient),
}));

vi.mock("../../../../../../src/infrastructure/matrix_router/matrix_router", () => ({
  MatrixRouter: { getNextProvider: vi.fn().mockResolvedValue("paddle") },
}));

const PID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const OWNER_ID = "c0a80101-0000-4000-8000-000000000001";
const RELEASE_SHA = "a".repeat(64);
const CHECKOUT_URL = `http://localhost:3000/api/billing/checkout?product=${PID}`;

type Product = { id: string; creator_id: string; release_sha256: string; checkout_mode: string; price_usd?: unknown };

function givenConsents() {
  return [
    { id: "c1", kind: "C1_data_accuracy", decision: "given", product_id: PID, supersedes: null },
    { id: "c2", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: null, document_sha256: RELEASE_SHA },
    { id: "c3", kind: "C3_revenue_split", decision: "given", product_id: PID, supersedes: null },
  ];
}

// Every table the route touches is recorded, so a test can prove no order or other write table was reached.
let touched: string[] = [];

function adminClient(product: Product, rails: Array<Record<string, unknown>>) {
  return {
    from: (table: string) => {
      touched.push(table);
      if (table === "products") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: product, error: null }) }),
          }),
        };
      }
      if (table === "consents") {
        const consents = givenConsents();
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({ data: consents, error: null, count: consents.length }),
            }),
          }),
        };
      }
      if (table === "product_rails") {
        return {
          select: () => ({
            eq: () => ({ order: async () => ({ data: rails, error: null }) }),
          }),
        };
      }
      // Any other table (an orders insert, for example) has no method here and would throw, failing the test.
      return {};
    },
  };
}

const livePaddleRail = [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live-rail", active: true }];

function request(): NextRequest {
  return new NextRequest(CHECKOUT_URL);
}

beforeEach(() => {
  adminModule.mockAdminClient = null;
  touched = [];
  vi.mocked(MatrixRouter.getNextProvider).mockReset();
  vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("billing/checkout: product with no price fails closed with 409 Conflict", () => {
  it.each([
    ["null", null],
    ["blank string", "   "],
    ["non-numeric string", "free"],
  ])("price_usd %s: 409 product_unpriced, no redirect, consents and rails never read", async (_label, price) => {
    adminModule.mockAdminClient = adminClient({ id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, checkout_mode: "live", price_usd: price }, livePaddleRail);
    const res = await GET(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "product_unpriced" });
    expect(res.headers.get("location")).toBeNull();
    expect(MatrixRouter.getNextProvider).not.toHaveBeenCalled();
    expect(touched).toEqual(["products"]);
  });

  it("a set price still reaches the rail (control: the 409 is the price gate, not a blanket refusal)", async () => {
    adminModule.mockAdminClient = adminClient({ id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, checkout_mode: "live", price_usd: "39.00" }, livePaddleRail);
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.paddle.com/live-rail");
  });
});

describe("billing/checkout: no active payment rail fails closed with 503 and Retry-After", () => {
  it("no rail rows: 503 no_active_rail with Retry-After from the registry, no redirect, router never asked", async () => {
    adminModule.mockAdminClient = adminClient({ id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, checkout_mode: "live", price_usd: "39.00" }, []);
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "no_active_rail" });
    expect(res.headers.get("retry-after")).toBe(String(GLOBAL.payments.checkout_no_rail_retry_after_seconds));
    expect(res.headers.get("location")).toBeNull();
    expect(MatrixRouter.getNextProvider).not.toHaveBeenCalled();
  });

  it("only inactive rail rows: same 503, and no order or provider table is written", async () => {
    adminModule.mockAdminClient = adminClient(
      { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, checkout_mode: "live", price_usd: "39.00" },
      [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live-rail", active: false }],
    );
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe(String(GLOBAL.payments.checkout_no_rail_retry_after_seconds));
    expect(res.headers.get("location")).toBeNull();
    // Only the read tables. No orders, sales or provider-labelled write table is reached on this path.
    expect(touched).toEqual(["products", "consents", "product_rails"]);
  });

  it("the Retry-After value is the registry setting (positive integer, within the registry limit)", () => {
    const seconds = GLOBAL.payments.checkout_no_rail_retry_after_seconds;
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(600);
  });
});
