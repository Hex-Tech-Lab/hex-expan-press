import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { MatrixRouter } from "../../../../../../src/infrastructure/matrix_router/matrix_router";
import { GLOBAL } from "../../../../../../payments/src/settings_registry";

const adminModule = vi.hoisted(() => ({
  mockAdminClient: null as unknown,
}));

const registryOverride = vi.hoisted(() => ({
  sandboxCheckoutEnabled: undefined as boolean | undefined,
}));

vi.mock("../../../../../../payments/src/settings_registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../payments/src/settings_registry")>();
  return {
    ...actual,
    GLOBAL: new Proxy(actual.GLOBAL, {
      get(target, prop, receiver) {
        if (prop === "payments" && registryOverride.sandboxCheckoutEnabled !== undefined) {
          return {
            ...target.payments,
            sandbox_checkout_enabled: registryOverride.sandboxCheckoutEnabled,
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

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

function makeAdminClient(
  checkoutMode = "live",
  rails: Array<{ provider: string; weight: number; checkout_url: string; active: boolean }> = [
    { provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live-rail", active: true },
  ],
) {
  const consents = [
    { id: "c1", kind: "C1_data_accuracy", decision: "given", product_id: PID, supersedes: null },
    { id: "c2", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: null, document_sha256: RELEASE_SHA },
    { id: "c3", kind: "C3_revenue_split", decision: "given", product_id: PID, supersedes: null },
  ];
  return {
    from: (table: string) => {
      if (table === "products") {
        const chain = {
          eq: () => chain,
          maybeSingle: async () => ({
            data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: "39.00", checkout_mode: checkoutMode },
            error: null,
          }),
        };
        return { select: () => chain };
      }
      if (table === "consents") {
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
            eq: () => ({
              order: async () => ({ data: rails, error: null }),
            }),
          }),
        };
      }
      return {};
    },
  };
}

describe("billing/checkout unavailable rail + staging runtime guards", () => {
  beforeEach(() => {
    adminModule.mockAdminClient = makeAdminClient();
    registryOverride.sandboxCheckoutEnabled = undefined;
    vi.mocked(MatrixRouter.getNextProvider).mockReset();
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 503 rail_misconfigured with registry Retry-After, a generic body, and a log when selected rail has no checkout_url", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Router resolves to a provider not in the filtered rails list, so rail?.checkout_url is missing.
      vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("creem");

      const res = await GET(new NextRequest(CHECKOUT_URL));
      expect(res.status).toBe(503);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("retry-after")).toBe(String(GLOBAL.payments.checkout_no_rail_retry_after_seconds));
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, code: "rail_misconfigured" });
      expect(JSON.stringify(body)).not.toContain("creem");
      expect(JSON.stringify(body)).not.toContain("paddle");
      const misconfiguredLogs = errorSpy.mock.calls.filter((args: unknown[]) => String(args[0]).includes("answering 503 rail_misconfigured"));
      expect(misconfiguredLogs).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("isNonProductionRuntime returns false for VERCEL_ENV=\"staging\" — refuses sandbox checkout_mode with 403", async () => {
    vi.stubEnv("VERCEL_ENV", "staging");
    vi.stubEnv("NODE_ENV", "test");
    registryOverride.sandboxCheckoutEnabled = true;
    adminModule.mockAdminClient = makeAdminClient("sandbox", [
      { provider: "paddle", weight: 100, checkout_url: "https://sandbox-api.polar.sh/v1/checkout-links/x/redirect", active: true },
    ]);

    const res = await GET(new NextRequest(CHECKOUT_URL));
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  it("isNonProductionRuntime returns false for VERCEL_ENV=\"staging\" — rejects sandbox rail URL with 500 even when sandbox_checkout_enabled=true", async () => {
    vi.stubEnv("VERCEL_ENV", "staging");
    vi.stubEnv("NODE_ENV", "test");
    registryOverride.sandboxCheckoutEnabled = true;
    adminModule.mockAdminClient = makeAdminClient("live", [
      { provider: "paddle", weight: 100, checkout_url: "https://sandbox-api.polar.sh/v1/checkout-links/x/redirect", active: true },
    ]);

    const res = await GET(new NextRequest(CHECKOUT_URL));
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toEqual({ ok: false, error: "Checkout is not configured" });
  });
});
