// fetchCheckoutProduct maps the shared resolver's activeCount to activeRailCount (storefront.tsx). The mapping is:
//   resolution.kind === "ok" ? resolution.activeCount : 0
// activeRailCount counts active rails whose provider is switched on, whether or not they are usable. The checkout page reads it
// to tell "Coming soon" (zero) from an outage (more than zero with no usable rail), so the count must not be the usable count.
import { describe, expect, it, vi, beforeEach } from "vitest";

const adminModule = vi.hoisted(() => ({ mockAdminClient: null as unknown }));
const verifierOverride = vi.hoisted(() => ({ names: undefined as Set<string> | undefined }));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));

vi.mock("../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => adminModule.mockAdminClient),
}));

// Enable a rail whose provider has no verifier (active and enabled, not usable) when the test needs it.
vi.mock("../app/api/billing/webhook/verifiers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/api/billing/webhook/verifiers")>();
  return {
    ...actual,
    verifiedProviderNames: () => verifierOverride.names ?? actual.verifiedProviderNames(),
  };
});

import { fetchCheckoutProduct } from "../src/components/storefront/storefront";

const PID = "57596c19-c550-4bde-b17a-e87b86d005c5";

const PRODUCT_ROW = {
  id: PID,
  store_product_id: "store_1",
  slug: "some_book",
  title: "Some Book",
  price_usd: "39.00",
  currency: "USD",
  working_note: null,
  description: null,
  disclaimers: null,
  checkout_mode: "live",
  paddle_price_id: "pri_live_1",
  inside: null,
  creators: { handle: "duane", display_name: "Duane", is_house: false },
};

function clientWithRails(rails: Array<Record<string, unknown>>) {
  return {
    from: (table: string) => {
      if (table === "products") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: PRODUCT_ROW, error: null }) }) }) };
      }
      if (table === "product_rails") {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: rails, error: null }) }) }) };
      }
      return {};
    },
  };
}

const PADDLE = { provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live-rail", active: true };

describe("fetchCheckoutProduct activeRailCount mapping (activeCount, not the usable count)", () => {
  beforeEach(() => {
    verifierOverride.names = undefined;
  });

  it("one active, enabled, verified rail: activeRailCount 1 and one usable rail", async () => {
    adminModule.mockAdminClient = clientWithRails([PADDLE]);
    const found = await fetchCheckoutProduct(PID);
    expect(found?.activeRailCount).toBe(1);
    expect(found?.usableRails).toHaveLength(1);
  });

  it("two active enabled rails: activeRailCount is 2, the number of active rails, not the highest-weight pick", async () => {
    adminModule.mockAdminClient = clientWithRails([PADDLE, { ...PADDLE, weight: 50 }]);
    const found = await fetchCheckoutProduct(PID);
    expect(found?.activeRailCount).toBe(2);
    expect(found?.usableRails).toHaveLength(2);
  });

  it("an active rail that is enabled but has no verifier counts as active (1) while the usable list is empty", async () => {
    // storefront memoises the verified-provider set per module instance, so this case needs a fresh module that reads the override.
    vi.resetModules();
    const { fetchCheckoutProduct: freshFetch } = await import("../src/components/storefront/storefront");
    verifierOverride.names = new Set(["creem"]);
    adminModule.mockAdminClient = clientWithRails([PADDLE]);
    const found = await freshFetch(PID);
    expect(found?.activeRailCount).toBe(1);
    expect(found?.usableRails).toHaveLength(0);
  });

  it("a switched-off rail (active=false) is not counted: activeRailCount 0 (designed Coming soon state)", async () => {
    adminModule.mockAdminClient = clientWithRails([{ ...PADDLE, active: false }]);
    const found = await fetchCheckoutProduct(PID);
    expect(found?.activeRailCount).toBe(0);
    expect(found?.usableRails).toHaveLength(0);
  });

  it("a malformed active row (weight 0) answers activeRailCount 0 because the resolution is malformed, not ok", async () => {
    adminModule.mockAdminClient = clientWithRails([{ ...PADDLE, weight: 0 }]);
    const found = await fetchCheckoutProduct(PID);
    expect(found?.activeRailCount).toBe(0);
    expect(found?.usableRails).toHaveLength(0);
  });
});
