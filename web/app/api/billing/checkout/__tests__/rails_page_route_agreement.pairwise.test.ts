// Agreement test (KYC P1, mor-label-shared-resolver): the checkout page and the checkout route must agree on the rails.
// For each rail count in {0, 1, 2} the same product_rails rows feed the REAL route GET and the REAL storefront
// fetchCheckoutProduct, then the page's decision (checkoutRailView, the one buyer rule) is compared with the route's outcome.
// Model: docs/testing/pairwise/checkout_rails_resolver.model.txt (rails axis). Oracle written from the specification.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { MatrixRouter } from "../../../../../../src/infrastructure/matrix_router/matrix_router";
import { fetchCheckoutProduct } from "../../../../../src/components/storefront/storefront";
import { checkoutRailView } from "../../../../../src/lib/checkout-rails";
import { GLOBAL } from "../../../../../../payments/src/settings_registry";

vi.mock("server-only", () => ({}));

// Creem is off by default (Paddle-only launch). The two-rail case needs two usable rails, so this test switches Creem on for
// both the route and the storefront read. Everything else in the registry is the real one.
vi.mock("../../../../../../payments/src/settings_registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../payments/src/settings_registry")>();
  return { ...actual, isEnabledPaymentProvider: (name: string) => name === "paddle" || name === "creem" };
});

const adminModule = vi.hoisted(() => ({ mockAdminClient: null as unknown }));

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

type RailCount = "zero" | "one" | "two";
const RAIL_COUNTS: RailCount[] = ["zero", "one", "two"];

/** The same product_rails rows the database would hold for each count. Two rails: paddle (weight 100) then creem (50). */
function railRows(count: RailCount) {
  if (count === "zero") return [];
  const paddle = { provider: "paddle", weight: 100, checkout_url: PADDLE_URL, active: true };
  if (count === "one") return [paddle];
  return [paddle, { provider: "creem", weight: 50, checkout_url: CREEM_URL, active: true }];
}

function givenConsents() {
  return [
    { id: "c1", kind: "C1_data_accuracy", decision: "given", product_id: PID, supersedes: null },
    { id: "c2", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: null, document_sha256: RELEASE_SHA },
    { id: "c3", kind: "C3_revenue_split", decision: "given", product_id: PID, supersedes: null },
  ];
}

/** One Supabase client for both readers: the route (products, consents, product_rails) and storefront (products with creators). */
function clientFor(count: RailCount) {
  const product = {
    id: PID,
    store_product_id: "prod_live_1",
    slug: "book",
    title: "Book",
    price_usd: "39.00",
    currency: "USD",
    creator_id: OWNER_ID,
    release_sha256: RELEASE_SHA,
    checkout_mode: "live",
    paddle_price_id: null,
    creators: { handle: "ada", display_name: "Ada", is_house: false },
  };
  const rails = railRows(count);
  return {
    from: (table: string) => {
      if (table === "products") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: product, error: null }) }) }) };
      }
      if (table === "consents") {
        const consents = givenConsents();
        return { select: () => ({ eq: () => ({ in: async () => ({ data: consents, error: null, count: consents.length }) }) }) };
      }
      if (table === "product_rails") {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: rails, error: null }) }) }) };
      }
      return {};
    },
  };
}

beforeEach(() => {
  vi.mocked(MatrixRouter.getNextProvider).mockReset();
  vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
});

describe("checkout page and route agree on rails (PICT rails axis: zero, one, two)", () => {
  it.each(RAIL_COUNTS.map((c) => [c] as const))("rails=%s: the page's buy decision matches the route's outcome", async (count) => {
    adminModule.mockAdminClient = clientFor(count);

    // Route side: the real GET answers the buy request.
    const res = await GET(new NextRequest(`http://localhost:3000/api/billing/checkout?product=${PID}`));

    // Page side: the real storefront read, then the one buyer rule the page uses.
    const found = await fetchCheckoutProduct(PID);
    expect(found).not.toBeNull();
    const page = checkoutRailView(found!.product, found!.usableRails);

    if (count === "zero") {
      // Coming soon on the page, and the route refuses with 503 no_active_rail, never a redirect.
      expect(page).toEqual({ purchasable: false, merchantOfRecordProvider: null });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "no_active_rail" });
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("retry-after")).toBe(String(GLOBAL.payments.checkout_no_rail_retry_after_seconds));
    } else if (count === "one") {
      // Buy form, merchant of record named, and the route redirects to that one rail.
      expect(page).toEqual({ purchasable: true, merchantOfRecordProvider: "paddle" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(PADDLE_URL);
    } else {
      // Buy form (POST fallback), no merchant of record, and the route still redirects to one of the usable rails.
      expect(page).toEqual({ purchasable: true, merchantOfRecordProvider: null });
      expect(res.status).toBe(302);
      // MatrixRouter is mocked to pick paddle, so the redirect must be exactly the paddle rail (not creem).
      expect(res.headers.get("location")).toBe(PADDLE_URL);
    }
  });
});
