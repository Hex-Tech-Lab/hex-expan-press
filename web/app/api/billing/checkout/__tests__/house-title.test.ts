// House title exemption at the checkout route (founder decision, 2026-11-19). A house product (creators.is_house) skips the creator
// consents C1-C3 and must still match its pinned release digest (house_release_pins). Creator products keep the consent gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { isHouseProduct, type ProductRow } from "../checkout-helpers";

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
const OWNER = "c0a80101-0000-4000-8000-000000000001";
const RELEASE_SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const CHECKOUT_URL = `http://localhost:3000/api/billing/checkout?product=${PID}`;
const HOUSE_RAIL = "https://buy.paddle.com/house-live";
const CONSENT_VERIFICATION_FAILED = "Checkout consent verification failed";

interface Scenario {
  isHouse: boolean;
  /** Result of the house_release_pins read. Defaults to the pin matching the release. */
  pin?: { data: unknown; error: { message: string } | null };
  /** Creator consent rows the consents read returns. */
  consents?: Array<{ id: string; kind: string; decision: string; product_id: string; supersedes: string | null; document_sha256?: string }>;
}

// Every table the route reads, in order, so a test can prove which gate ran.
let touched: string[] = [];

function givenCreatorConsents(): NonNullable<Scenario["consents"]> {
  return [
    { id: "c1", kind: "C1_data_accuracy", decision: "given", product_id: PID, supersedes: null },
    { id: "c2", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: null, document_sha256: RELEASE_SHA },
    { id: "c3", kind: "C3_revenue_split", decision: "given", product_id: PID, supersedes: null },
  ];
}

function buildClient(s: Scenario) {
  return {
    from: (table: string) => {
      touched.push(table);
      if (table === "products") {
        const chain = {
          eq: () => chain,
          maybeSingle: async () => ({
            data: {
              id: PID,
              creator_id: OWNER,
              release_sha256: RELEASE_SHA, price_usd: "39.00",
              checkout_mode: "live",
              paddle_price_id: null,
              creators: { handle: "house_handle", is_house: s.isHouse },
            },
            error: null,
          }),
          limit: async () => ({ data: [], error: null }),
        };
        return { select: () => chain };
      }
      if (table === "house_release_pins") {
        const pin = s.pin ?? { data: { sha256: RELEASE_SHA }, error: null };
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => pin }),
          }),
        };
      }
      if (table === "consents") {
        const rows = s.consents ?? givenCreatorConsents();
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({ data: rows, error: null, count: rows.length }),
            }),
          }),
        };
      }
      if (table === "product_rails") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({
                data: [{ provider: "paddle", weight: 100, checkout_url: HOUSE_RAIL, active: true }],
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    },
  };
}

function request(): NextRequest {
  return new NextRequest(CHECKOUT_URL);
}

beforeEach(() => {
  touched = [];
  adminModule.mockAdminClient = null;
  vi.stubEnv("VERCEL_ENV", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("house title: checkout skips creator consents and keeps the pinned release hash", () => {
  it("a house product with no creator consents routes to its rail, and the consents table is never read", async () => {
    adminModule.mockAdminClient = buildClient({ isHouse: true, consents: [] });
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(HOUSE_RAIL);
    expect(touched).toContain("house_release_pins");
    expect(touched).not.toContain("consents");
  });

  it("a house product ignores a refused creator consent, because it has no creator consents to refuse", async () => {
    adminModule.mockAdminClient = buildClient({
      isHouse: true,
      consents: [{ id: "c1", kind: "C1_data_accuracy", decision: "refused", product_id: PID, supersedes: null }],
    });
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(touched).not.toContain("consents");
  });

  it("a house product whose release differs from its pin is refused (the file must still match)", async () => {
    adminModule.mockAdminClient = buildClient({ isHouse: true, pin: { data: { sha256: OTHER_SHA }, error: null } });
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "Checkout forbidden: release hash mismatch" });
    expect(res.headers.get("location")).toBeNull();
  });

  it("a house product with no pin row is refused, never routed on the release alone", async () => {
    adminModule.mockAdminClient = buildClient({ isHouse: true, pin: { data: null, error: null } });
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "Checkout forbidden: release hash mismatch" });
    expect(res.headers.get("location")).toBeNull();
  });

  it("a house product fails closed when the pin read errors", async () => {
    adminModule.mockAdminClient = buildClient({ isHouse: true, pin: { data: null, error: { message: "pins query failed" } } });
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: CONSENT_VERIFICATION_FAILED });
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("creator products keep the consent gate (the exemption does not leak)", () => {
  it("a creator product with no active consents is still refused, and the pin table is never read", async () => {
    adminModule.mockAdminClient = buildClient({ isHouse: false, consents: [] });
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "Checkout forbidden: required creator consents are not active" });
    expect(touched).toContain("consents");
    expect(touched).not.toContain("house_release_pins");
  });

  it("a creator product with all three consents given and a matching C2 still routes (unchanged path)", async () => {
    adminModule.mockAdminClient = buildClient({ isHouse: false });
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(touched).toContain("consents");
    expect(touched).not.toContain("house_release_pins");
  });
});

describe("isHouseProduct reads only a strict boolean from the creator embed", () => {
  const product = (creators: ProductRow["creators"]): ProductRow => ({ id: PID, creator_id: OWNER, creators });

  it("is true for an object embed and for the array form", () => {
    expect(isHouseProduct(product({ handle: "h", is_house: true }))).toBe(true);
    expect(isHouseProduct(product([{ handle: "h", is_house: true }]))).toBe(true);
  });

  it("is false for a creator, a missing embed, or a non-boolean flag", () => {
    expect(isHouseProduct(product({ handle: "h", is_house: false }))).toBe(false);
    expect(isHouseProduct(product(null))).toBe(false);
    expect(isHouseProduct(product(undefined))).toBe(false);
    expect(isHouseProduct(product({ handle: "h", is_house: "true" as unknown as boolean }))).toBe(false);
    expect(isHouseProduct(product([]))).toBe(false);
  });
});
