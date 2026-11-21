// Checkout Sentry tags and transient-read contract.
// - rails_unavailable: every rail is marked down by the router breaker (503), and the outage is reported with its tag.
// - lookup_unavailable: a product or rails database read that fails is a transient 503 with registry Retry-After, not a 500.
// - no_active_rail: reported ONLY when an active, enabled rail exists and none is usable. A switched-off rail is silent by design.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { MatrixRouter } from "../../../../../../src/infrastructure/matrix_router/matrix_router";
import { MatrixRouterUnavailableError } from "../../../../../../src/infrastructure/matrix_router/matrix_router_errors";
import { GLOBAL } from "../../../../../../payments/src/settings_registry";

const adminModule = vi.hoisted(() => ({ mockAdminClient: null as unknown }));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
const verifierOverride = vi.hoisted(() => ({ names: undefined as Set<string> | undefined }));

vi.mock("@sentry/nextjs", () => ({ captureException: sentry.captureException }));

vi.mock("../../../../../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => adminModule.mockAdminClient),
}));

vi.mock("../../../../../../src/infrastructure/matrix_router/matrix_router", () => ({
  MatrixRouter: { getNextProvider: vi.fn().mockResolvedValue("paddle") },
}));

// Force a rail to be enabled but unverified (no webhook verifier), so an active rail exists and none is usable.
vi.mock("../../webhook/verifiers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../webhook/verifiers")>();
  return {
    ...actual,
    verifiedProviderNames: () => verifierOverride.names ?? actual.verifiedProviderNames(),
  };
});

const PID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const OWNER_ID = "c0a80101-0000-4000-8000-000000000001";
const RELEASE_SHA = "a".repeat(64);
const CHECKOUT_URL = `http://localhost:3000/api/billing/checkout?product=${PID}`;
const PRODUCT = { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, checkout_mode: "live", price_usd: "39.00" };
const CONSENTS = [
  { id: "c1", kind: "C1_data_accuracy", decision: "given", product_id: PID, supersedes: null },
  { id: "c2", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: null, document_sha256: RELEASE_SHA },
  { id: "c3", kind: "C3_revenue_split", decision: "given", product_id: PID, supersedes: null },
];

type Rail = Record<string, unknown>;

// Mirrors the chain the route calls: products (select, eq, maybeSingle), consents (select, eq, in), product_rails (select, eq, order).
function client(opts: {
  product?: { data: unknown; error: unknown };
  rails?: { data: unknown; error: unknown };
  rows?: Rail[];
}) {
  return {
    from: (table: string) => {
      if (table === "products") {
        const res = opts.product ?? { data: PRODUCT, error: null };
        return { select: () => ({ eq: () => ({ maybeSingle: async () => res }) }) };
      }
      if (table === "consents") {
        return { select: () => ({ eq: () => ({ in: async () => ({ data: CONSENTS, error: null, count: CONSENTS.length }) }) }) };
      }
      if (table === "product_rails") {
        const res = opts.rails ?? { data: opts.rows ?? [], error: null };
        return { select: () => ({ eq: () => ({ order: async () => res }) }) };
      }
      return {};
    },
  };
}

const PADDLE_LIVE: Rail = { provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live-rail", active: true };

describe("billing/checkout Sentry tags and transient reads", () => {
  beforeEach(() => {
    sentry.captureException.mockClear();
    verifierOverride.names = undefined;
    adminModule.mockAdminClient = client({ rows: [PADDLE_LIVE] });
    vi.mocked(MatrixRouter.getNextProvider).mockReset();
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rails_unavailable: a breaker outage answers 503 with registry Retry-After and is reported to Sentry with its tag", async () => {
    vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new MatrixRouterUnavailableError("payments", PID));
    const res = await GET(new NextRequest(CHECKOUT_URL));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "rails_unavailable" });
    expect(res.headers.get("retry-after")).toBe(String(GLOBAL.payments.checkout_router_error_retry_after_seconds));
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [reported, options] = sentry.captureException.mock.calls[0] as [unknown, { tags: Record<string, string> }];
    expect(reported).toBeInstanceOf(MatrixRouterUnavailableError);
    expect(options.tags).toEqual({ surface: "checkout_route", reason: "rails_unavailable" });
  });

  it("a product read error answers 503 lookup_unavailable with registry Retry-After and reports product_lookup_failed", async () => {
    adminModule.mockAdminClient = client({ product: { data: null, error: { message: "products read timeout" } } });
    const res = await GET(new NextRequest(CHECKOUT_URL));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe(String(GLOBAL.payments.checkout_db_retry_after_seconds));
    expect(await res.json()).toMatchObject({ ok: false, code: "lookup_unavailable" });
    expect(res.headers.get("location")).toBeNull();
    const tags = sentry.captureException.mock.calls.map((c) => (c[1] as { tags: Record<string, string> }).tags);
    expect(tags).toEqual([{ surface: "checkout_route", reason: "product_lookup_failed" }]);
  });

  it("a product_rails read error answers 503 lookup_unavailable with registry Retry-After and reports rails_query_failed", async () => {
    adminModule.mockAdminClient = client({ rails: { data: null, error: { message: "rails read timeout" } } });
    const res = await GET(new NextRequest(CHECKOUT_URL));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe(String(GLOBAL.payments.checkout_db_retry_after_seconds));
    expect(await res.json()).toMatchObject({ ok: false, code: "lookup_unavailable" });
    expect(res.headers.get("location")).toBeNull();
    const tags = sentry.captureException.mock.calls.map((c) => (c[1] as { tags: Record<string, string> }).tags);
    expect(tags).toEqual([{ surface: "checkout_route", reason: "rails_query_failed" }]);
  });

  it("no_active_rail fires: an active, enabled rail with no verifier is an outage, reported with its tag", async () => {
    verifierOverride.names = new Set(["creem"]);
    const res = await GET(new NextRequest(CHECKOUT_URL));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "no_active_rail" });
    expect(res.headers.get("retry-after")).toBe(String(GLOBAL.payments.checkout_no_rail_retry_after_seconds));
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [, options] = sentry.captureException.mock.calls[0] as [unknown, { tags: Record<string, string> }];
    expect(options.tags).toEqual({ surface: "checkout_route", reason: "no_active_rail" });
  });

  it("no_active_rail is silent for a switched-off rail (active=false): 503 with no Sentry report", async () => {
    adminModule.mockAdminClient = client({ rows: [{ ...PADDLE_LIVE, active: false }] });
    const res = await GET(new NextRequest(CHECKOUT_URL));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "no_active_rail" });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("no_active_rail is silent when the product has no rail rows at all: 503 with no Sentry report", async () => {
    adminModule.mockAdminClient = client({ rows: [] });
    const res = await GET(new NextRequest(CHECKOUT_URL));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "no_active_rail" });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
