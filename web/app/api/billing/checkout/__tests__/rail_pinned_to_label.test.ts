// The rail a buyer is shown (the merchant of record label) must be the rail the route charges. The page sends the rail it labelled
// as `rail`; the route answers 409 rail_changed, with no redirect and no order, when the router would pick a different rail.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { parsePostBody } from "../checkout-helpers";
import { MatrixRouter } from "../../../../../../src/infrastructure/matrix_router/matrix_router";

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
const PADDLE_URL = "https://buy.paddle.com/live-rail";
const CREEM_URL = "https://buy.creem.io/live-rail-2";

const PRODUCT = { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, checkout_mode: "live", price_usd: "39.00" };
const paddleRail = { provider: "paddle", weight: 100, checkout_url: PADDLE_URL, active: true };
const creemRail = { provider: "creem", weight: 50, checkout_url: CREEM_URL, active: true };

function givenConsents() {
  return [
    { id: "c1", kind: "C1_data_accuracy", decision: "given", product_id: PID, supersedes: null },
    { id: "c2", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: null, document_sha256: RELEASE_SHA },
    { id: "c3", kind: "C3_revenue_split", decision: "given", product_id: PID, supersedes: null },
  ];
}

let touched: string[] = [];

function adminClient(rails: Array<Record<string, unknown>>) {
  return {
    from: (table: string) => {
      touched.push(table);
      if (table === "products") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: PRODUCT, error: null }) }) }) };
      }
      if (table === "consents") {
        const consents = givenConsents();
        return {
          select: () => ({ eq: () => ({ in: async () => ({ data: consents, error: null, count: consents.length }) }) }),
        };
      }
      if (table === "product_rails") {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: rails, error: null }) }) }) };
      }
      return {};
    },
  };
}

function checkoutRequest(rail?: string): NextRequest {
  const qs = new URLSearchParams({ product: PID });
  if (rail !== undefined) qs.set("rail", rail);
  return new NextRequest(`http://localhost:3000/api/billing/checkout?${qs.toString()}`);
}

beforeEach(() => {
  adminModule.mockAdminClient = null;
  touched = [];
  vi.mocked(MatrixRouter.getNextProvider).mockReset();
  vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
});

describe("checkout route: the charged rail must be the rail the buyer was shown", () => {
  it("two usable rails, router picks paddle, page labelled creem: 409 rail_changed, no redirect, no order", async () => {
    adminModule.mockAdminClient = adminClient([paddleRail, creemRail]);
    const res = await GET(checkoutRequest("creem"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "rail_changed" });
    expect(res.headers.get("location")).toBeNull();
    expect(MatrixRouter.getNextProvider).toHaveBeenCalledTimes(1);
    expect(touched).not.toContain("orders");
  });

  it("single usable rail that changed since the page rendered (page labelled creem, only paddle live): 409 rail_changed", async () => {
    adminModule.mockAdminClient = adminClient([paddleRail]);
    const res = await GET(checkoutRequest("creem"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "rail_changed" });
    expect(res.headers.get("location")).toBeNull();
  });

  it("control: page labelled paddle and router picks paddle: redirect to the paddle rail", async () => {
    adminModule.mockAdminClient = adminClient([paddleRail, creemRail]);
    const res = await GET(checkoutRequest("paddle"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(PADDLE_URL);
  });

  it("control: no label sent (multi-rail page shows no merchant of record): unchanged behaviour, router's pick is used", async () => {
    adminModule.mockAdminClient = adminClient([paddleRail, creemRail]);
    const res = await GET(checkoutRequest());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(PADDLE_URL);
  });
});

describe("parsePostBody: the labelled rail is read from the POST body", () => {
  const postUrl = `http://localhost:3000/api/billing/checkout`;

  it("reads rail from a JSON body", async () => {
    const req = new NextRequest(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product: PID, rail: "creem" }),
    });
    const parsed = await parsePostBody(req);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.expectedRail).toBe("creem");
  });

  it("reads rail from a form-encoded body", async () => {
    const req = new NextRequest(postUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `product=${PID}&rail=paddle`,
    });
    const parsed = await parsePostBody(req);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.expectedRail).toBe("paddle");
  });

  it("is null when no rail is sent", async () => {
    const req = new NextRequest(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product: PID }),
    });
    const parsed = await parsePostBody(req);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.expectedRail).toBeNull();
  });
});
