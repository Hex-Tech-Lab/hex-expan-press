import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { MatrixRouter } from "../../../../../../src/infrastructure/matrix_router/matrix_router";
import { portRails } from "../../../../../../scripts/lib/heritage-rails";

const adminModule = vi.hoisted(() => ({
  mockAdminClient: null as unknown,
}));


vi.mock("../../../../../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => adminModule.mockAdminClient),
}));


// Mock depth is 6 ups from __tests__ (route.ts resolves the same module with
// 5 ups from checkout/) — both resolve to src/infrastructure/matrix_router/matrix_router.ts.
vi.mock("../../../../../../src/infrastructure/matrix_router/matrix_router", () => ({
  MatrixRouter: { getNextProvider: vi.fn().mockResolvedValue("polar") },
}));

const CHECKOUT_URL = "http://localhost:3000/api/billing/checkout?product=duane_retirement_playbook_v1";

// Consent-gate mock plumbing (CR remediation): the route's gate now chains
// .select().or()/.eq().maybeSingle() on products and .select().eq() on
// consents (creator_id scoping), so the mock mirrors those call shapes.
// Sprint 15: rails come from the product_rails table —
// .select().eq().eq().order() — mocked through the same admin client.
const PID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const OWNER_ID = "c0a80101-0000-4000-8000-000000000001";
const RELEASE_SHA = "a".repeat(64);

interface DbResult {
  data: unknown;
  error: { message: string } | null;
}

function givenConsents(): Array<{ id: string; kind: string; decision: string; product_id: string; supersedes: string | null; document_sha256?: string }> {
  return [
    { id: "c1", kind: "C1_data_accuracy", decision: "given", product_id: PID, supersedes: null },
    { id: "c2", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: null, document_sha256: RELEASE_SHA },
    { id: "c3", kind: "C3_revenue_split", decision: "given", product_id: PID, supersedes: null },
  ];
}

function productTableMock(products: DbResult) {
  return {
    select: () => ({
      or: () => ({ maybeSingle: async () => products }),
      eq: () => ({ maybeSingle: async () => products }),
    }),
  };
}

function consentsTableMock(consents: DbResult) {
  return { select: () => ({ eq: async () => consents }) };
}

function railsTableMock(rails: DbResult) {
  return {
    select: () => ({
      eq: () => ({
        order: async () => rails,
      }),
    }),
  };
}

function gateAdminClient(
  products: DbResult = { data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA }, error: null },
  consents: DbResult = { data: givenConsents(), error: null },
  rails: DbResult = { data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-rail", active: true }], error: null },
) {
  return {
    from: (table: string) => {
      if (table === "products") {
        return productTableMock(products);
      }
      if (table === "consents") {
        return consentsTableMock(consents);
      }
      if (table === "product_rails") {
        return railsTableMock(rails);
      }
      return {};
    },
  };
}

// The handler reads request.nextUrl, so a plain Request cast is not enough —
// build a real NextRequest.
function request(): NextRequest {
  return new NextRequest(CHECKOUT_URL);
}

// CR remediation: every test starts with the admin client unset so no
// mockAdminClient assignment leaks between tests — a test that needs the gate
// to pass sets its own mock (the rail describes do so in their beforeEach).
beforeEach(() => {
  adminModule.mockAdminClient = null;
});

describe("billing/checkout launch-product default rail", () => {
  beforeEach(() => {
    // true unset (not "") — under the wave85 policy a SET-but-blank override
    // is itself a 500, which would break every default-rail test here.
    vi.stubEnv("CHECKOUT_URL_DUANE_RETIREMENT_PLAYBOOK_V1", undefined as unknown as string);
    // Gate must pass and DB rails must be EMPTY so these tests reach the
    // env/legacy fallback branches they exist to cover.
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, { data: [], error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed with 500 and no redirect when POLAR_CHECKOUT_URL is unset in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", "");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects to POLAR_CHECKOUT_URL in production when configured", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", "https://buy.polar.sh/live-test-link");
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.polar.sh/live-test-link");
  });

  it("falls back to the sandbox link outside production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("POLAR_CHECKOUT_URL", "");
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sandbox-api.polar.sh");
  });
});

describe("billing/checkout unified checkout_url policy", () => {
  beforeEach(() => {
    // true unset (not "") — under the wave85 policy a SET-but-blank override
    // is itself a 500, which would break every default-rail test here.
    vi.stubEnv("CHECKOUT_URL_DUANE_RETIREMENT_PLAYBOOK_V1", undefined as unknown as string);
    // Gate must pass and DB rails must be EMPTY so these tests reach the
    // env/legacy fallback branches they exist to cover.
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, { data: [], error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("production with POLAR_CHECKOUT_URL truly unset returns 500 without a location", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", undefined as unknown as string);
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("VERCEL_ENV unset with NODE_ENV=production and POLAR_CHECKOUT_URL unset returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", undefined as unknown as string);
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production with whitespace-only POLAR_CHECKOUT_URL returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", "   ");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production with a malformed POLAR_CHECKOUT_URL returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", "not a url");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production with a sandbox POLAR_CHECKOUT_URL returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", "https://sandbox-api.polar.sh/v1/checkout-links/x/redirect");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production with a sandbox CHECKOUT_URL_<PRODUCT> override returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("CHECKOUT_URL_DUANE_RETIREMENT_PLAYBOOK_V1", "https://sandbox-api.polar.sh/x");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production CHECKOUT_URL_<PRODUCT> override wins over POLAR_CHECKOUT_URL and redirects", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", "https://buy.polar.sh/live-test-link");
    vi.stubEnv("CHECKOUT_URL_DUANE_RETIREMENT_PLAYBOOK_V1", "https://buy.polar.sh/live-override");
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.polar.sh/live-override");
  });

  it("production DB rails serving a sandbox checkout_url returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "polar", weight: 100, checkout_url: "https://sandbox-api.polar.sh/x", active: true }],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("billing/checkout wave85 sandbox + raw-URL fail-closed", () => {
  beforeEach(() => {
    // true unset (not "") — a SET-but-blank override is itself a 500.
    vi.stubEnv("CHECKOUT_URL_DUANE_RETIREMENT_PLAYBOOK_V1", undefined as unknown as string);
    // Gate must pass and DB rails must be EMPTY so these tests reach the
    // env/legacy fallback branches they exist to cover.
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, { data: [], error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // A queued mockRejectedValueOnce can survive an early-500 test (router
    // never reached) — reset so later tests keep the default resolution.
    vi.mocked(MatrixRouter.getNextProvider).mockReset();
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("polar");
  });

  it("VERCEL_ENV unset + NODE_ENV unset + POLAR_CHECKOUT_URL unset returns 500 (absent signals fail closed)", async () => {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("NODE_ENV", undefined as unknown as string);
    vi.stubEnv("POLAR_CHECKOUT_URL", undefined as unknown as string);
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("VERCEL_ENV unset + NODE_ENV=staging + POLAR_CHECKOUT_URL unset returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("NODE_ENV", "staging");
    vi.stubEnv("POLAR_CHECKOUT_URL", undefined as unknown as string);
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("VERCEL_ENV unset + NODE_ENV=test still serves the sandbox link (302)", async () => {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("POLAR_CHECKOUT_URL", undefined as unknown as string);
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sandbox-api.polar.sh");
  });

  it("production rejects POLAR_CHECKOUT_URL whose hostname carries a sandbox label", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", "https://foo-sandbox-api.example.com/x");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production allows a host where 'sandbox' is only a substring (no sandbox label)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", "https://sandboxpay.example.com/x");
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://sandboxpay.example.com/x");
  });

  it("production with SET-but-blank override does not fall through to a valid POLAR_CHECKOUT_URL", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", "https://buy.polar.sh/live-test-link");
    vi.stubEnv("CHECKOUT_URL_DUANE_RETIREMENT_PLAYBOOK_V1", "   ");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production DB rails with checkout_url omitted / null / 42, or a null / non-object rail, returns 500 each with no location", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    for (const rails of [
      [{ provider: "polar", weight: 100, active: true }],
      [{ provider: "polar", weight: 100, checkout_url: null, active: true }],
      [{ provider: "polar", weight: 100, checkout_url: 42, active: true }],
      [null],
      ["not-an-object"],
    ]) {
      adminModule.mockAdminClient = gateAdminClient(undefined, undefined, { data: rails, error: null });
      const res = await GET(request());
      expect(res.status, `rails=${JSON.stringify(rails)}`).toBe(500);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("production with rejecting MatrixRouter and valid live rails falls back 302 to the live url", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-rail", active: true }],
      error: null,
    });
    vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new Error("router down"));
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.polar.sh/live-rail");
  });

  it("production with rejecting MatrixRouter and a null-url rail fails closed 500 before the router", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "polar", weight: 100, checkout_url: null, active: true }],
      error: null,
    });
    vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new Error("router down"));
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("billing/checkout path traversal sanitization (P3)", () => {
  it("rejects path traversal attempts with 400 Bad Request", async () => {
    for (const badProduct of [
      "../secret",
      "..\\secret",
      "foo/bar",
      "foo\\bar",
      "../../etc/passwd",
      "a".repeat(100),
      "invalid!product",
    ]) {
      const req = new NextRequest(`http://localhost:3000/api/billing/checkout?product=${encodeURIComponent(badProduct)}`);
      const res = await GET(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Invalid product parameter in URL");
    }
  });
});

describe("billing/checkout active consent gate (P1)", () => {
  it("returns 403 Forbidden when active consents (C1/C2/C3) are not all given", async () => {
    // Only C1 is given, C2 and C3 are missing
    adminModule.mockAdminClient = gateAdminClient(undefined, {
      data: [
        {
          id: "c1",
          kind: "C1_data_accuracy",
          decision: "given",
          product_id: PID,
          supersedes: null,
        },
      ],
      error: null,
    });

    const res = await GET(request());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/required creator consents are not active/);
  });

  it("returns 403 when a required kind has AMBIGUOUS heads (given + refused race leftover) — strict single-head gate", async () => {
    // Pre-lock concurrent submissions can fork a kind into two heads: the
    // permissive display resolver would count C2 as active off the given
    // head; the money path must fail closed (CR round-2, PR #85).
    adminModule.mockAdminClient = gateAdminClient(undefined, {
      data: [
        { id: "c1", kind: "C1_data_accuracy", decision: "given", product_id: PID, supersedes: null },
        { id: "c2_a", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: null },
        { id: "c2_b", kind: "C2_release_approval", decision: "refused", product_id: PID, supersedes: null },
        { id: "c3", kind: "C3_revenue_split", decision: "given", product_id: PID, supersedes: null },
      ],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  it("returns 403 Forbidden when a consent was superseded by a refusal", async () => {    adminModule.mockAdminClient = gateAdminClient(undefined, {
      data: [
        { id: "c1", kind: "C1_data_accuracy", decision: "given", product_id: PID, supersedes: null },
        { id: "c2_old", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: null },
        { id: "c2_new", kind: "C2_release_approval", decision: "refused", product_id: PID, supersedes: "c2_old" },
        { id: "c3", kind: "C3_revenue_split", decision: "given", product_id: PID, supersedes: null },
      ],
      error: null,
    });

    const res = await GET(request());
    expect(res.status).toBe(403);
  });

  it("allows checkout URL routing when C1, C2, and C3 are all active", async () => {
    adminModule.mockAdminClient = gateAdminClient();

    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await GET(request());
    expect(res.status).toBe(302);
  });
});

describe("billing/checkout consent gate fails closed (CR remediation)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 500 (never a 302) when the admin client is null", async () => {
    // mockAdminClient left null by the shared beforeEach — verification is
    // impossible, so the gate must fail closed instead of skipping.
    const res = await GET(request());
    expect(res.status).not.toBe(302);
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    const body = await res.json();
    expect(body.error).toMatch(/consent verification failed/);
  });

  it("returns 500 when the product lookup errors (e.g. PostgREST uuid cast failure)", async () => {
    adminModule.mockAdminClient = gateAdminClient({ data: null, error: { message: "invalid input syntax for type uuid" } });
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("returns 500 for an unknown product that is not a legacy launch slug", async () => {
    const req = new NextRequest("http://localhost:3000/api/billing/checkout?product=never-heard-of-it");
    adminModule.mockAdminClient = gateAdminClient({ data: null, error: null });
    const res = await GET(req);
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("returns 500 for a legacy slug when its mapped product id has no row", async () => {
    adminModule.mockAdminClient = gateAdminClient({ data: null, error: null });
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it.each(["duane_retirement_playbook_v1", "retirearly500k-500k-playbook"])(
    "rewrites legacy slug %s to the canonical product id before the DB lookup",
    async (legacy) => {
      vi.stubEnv("VERCEL_ENV", "preview");
      const filters: string[] = [];
      adminModule.mockAdminClient = {
        from: (table: string) => {
          if (table === "products") {
            return {
              select: () => ({
                or: (f: string) => {
                  filters.push(f);
                  return { maybeSingle: async () => ({ data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA }, error: null }) };
                },
              }),
            };
          }
          if (table === "product_rails") {
            return railsTableMock({ data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-rail", active: true }], error: null });
          }
          return consentsTableMock({ data: givenConsents(), error: null });
        },
      };
      const res = await GET(new NextRequest(`http://localhost:3000/api/billing/checkout?product=${legacy}`));
      expect(res.status).toBe(302);
      expect(filters).toEqual([`slug.eq.${PID},id.eq.${PID}`]);
    },
  );

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "some-new-book"])(
    "treats non-legacy product %s as a literal slug in the DB filter",
    async (slug) => {
      vi.stubEnv("VERCEL_ENV", "preview");
      const filters: string[] = [];
      adminModule.mockAdminClient = {
        from: (table: string) => {
          if (table === "products") {
            return {
              select: () => ({
                or: (f: string) => {
                  filters.push(f);
                  return { maybeSingle: async () => ({ data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA }, error: null }) };
                },
              }),
            };
          }
          if (table === "product_rails") {
            return railsTableMock({ data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-rail", active: true }], error: null });
          }
          return consentsTableMock({ data: givenConsents(), error: null });
        },
      };
      const res = await GET(new NextRequest(`http://localhost:3000/api/billing/checkout?product=${slug}`));
      expect(res.status).toBe(302);
      expect(filters).toEqual([`slug.eq.${slug}`]);
    },
  );

  it("fails closed with 500 when the resolved product has no owner", async () => {
    adminModule.mockAdminClient = gateAdminClient({ data: { id: PID, creator_id: null }, error: null });
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("returns 500 when the consents query errors", async () => {
    adminModule.mockAdminClient = gateAdminClient(undefined, { data: null, error: { message: "consents query failed" } });
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("scopes the consents query to the product owner via creator_id (tenant isolation)", async () => {
    const eqCalls: Array<[string, string]> = [];
    adminModule.mockAdminClient = {
      from: (table: string) => {
        if (table === "consents") {
          return {
            select: () => ({
              eq: (col: string, val: string) => {
                eqCalls.push([col, val]);
                return { data: givenConsents(), error: null };
              },
            }),
          };
        }
        if (table === "product_rails") {
          return railsTableMock({ data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-rail", active: true }], error: null });
        }
        return productTableMock({ data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA }, error: null });
      },
    };
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(eqCalls).toContainEqual(["creator_id", OWNER_ID]);
  });
});

describe("billing/checkout DB-driven rails (Sprint 15 heritage eradication)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves the DB rail when product_rails has active rows (no env needed)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", undefined as unknown as string);
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/from-db", active: true }],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.polar.sh/from-db");
  });

  it("returns 404 when rails are configured but ALL inactive — the database disable defeats env/legacy fallback", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("CHECKOUT_URL_DUANE_RETIREMENT_PLAYBOOK_V1", "https://buy.polar.sh/env-override");
    vi.stubEnv("POLAR_CHECKOUT_URL", "https://buy.polar.sh/live-legacy-default");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/from-db", active: false }],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("serves the DB rail when SOME configured rails are active (inactive ones excluded from routing)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("POLAR_CHECKOUT_URL", undefined as unknown as string);
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [
        { provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-from-db", active: true },
        { provider: "paddle", weight: 50, checkout_url: "https://sandbox-api.polar.sh/inactive", active: false },
      ],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.polar.sh/live-from-db");
  });

  it("returns 500 when the product_rails query errors (fail closed)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: null,
      error: { message: "rails query failed" },
    });
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("falls through to the env override when the DB has no rails rows", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("CHECKOUT_URL_DUANE_RETIREMENT_PLAYBOOK_V1", "https://buy.polar.sh/env-override");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, { data: [], error: null });
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.polar.sh/env-override");
  });

  it("returns 404 for an unknown product with no DB rails, no env override, and no legacy mapping", async () => {
    const req = new NextRequest("http://localhost:3000/api/billing/checkout?product=some-other-product");
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = {
      from: (table: string) => {
        if (table === "products") {
          return productTableMock({ data: { id: "11111111-1111-1111-1111-111111111111", creator_id: OWNER_ID, release_sha256: RELEASE_SHA }, error: null });
        }
        if (table === "product_rails") {
          return railsTableMock({ data: [], error: null });
        }
        return consentsTableMock({
          data: givenConsents().map((r) => ({ ...r, product_id: "11111111-1111-1111-1111-111111111111" })),
          error: null,
        });
      },
    };
    const res = await GET(req);
    expect(res.status).toBe(404);
  });
});


describe("billing/checkout sandbox-rail purge regression (Sprint 17)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("importer skips a sandbox rail, leaving 0 rows, so checkout reaches the CHECKOUT_URL_<PRODUCT> fallback (302, not 404)", async () => {
    // In-memory product_rails, shared by the importer and the route.
    const railRows: Array<Record<string, unknown>> = [];
    const store = {
      from: (table: string) => {
        if (table === "product_rails") {
          return {
            upsert: async (row: Record<string, unknown>) => {
              railRows.push(row);
              return { error: null };
            },
            select: () => ({ eq: () => ({ order: async () => ({ data: railRows, error: null }) }) }),
          };
        }
        if (table === "products") return productTableMock({ data: { id: PID, creator_id: OWNER_ID }, error: null });
        return consentsTableMock({ data: givenConsents(), error: null });
      },
    };

    await portRails(
      store as never,
      "sandboxed-book",
      PID,
      [{ provider: "polar", weight: 1, checkout_url: "https://sandbox-api.polar.sh/v1/checkout-links/x/redirect" }],
      false,
    );
    expect(railRows).toHaveLength(0);

    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("CHECKOUT_URL_SANDBOXED_BOOK", "https://buy.polar.sh/live-sandboxed-book");
    adminModule.mockAdminClient = store;
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=sandboxed-book"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.polar.sh/live-sandboxed-book");
  });

  it("importer aborts on a malformed checkout_url and ignores stray rail fields", async () => {
    const railRows: Array<Record<string, unknown>> = [];
    const store = { from: () => ({ upsert: async (row: Record<string, unknown>) => (railRows.push(row), { error: null }) }) };
    await expect(
      portRails(store as never, "bad-book", PID, [{ provider: "polar", weight: 1, checkout_url: "not a url" }], false),
    ).rejects.toThrow(/malformed checkout_url/);
    const stray = { provider: "polar", weight: 1, checkout_url: "https://buy.polar.sh/x", product_id: "other" };
    await portRails(store as never, "stray-book", PID, [stray], false);
    expect(railRows).toEqual([{ product_id: PID, provider: "polar", weight: 1, checkout_url: "https://buy.polar.sh/x", active: true }]);
  });

  it("importer still ports a live rail as active", async () => {
    const railRows: Array<Record<string, unknown>> = [];
    const store = { from: () => ({ upsert: async (row: Record<string, unknown>) => (railRows.push(row), { error: null }) }) };
    await portRails(store as never, "live-book", PID, [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live" }], false);
    expect(railRows).toEqual([{ product_id: PID, provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live", active: true }]);
  });
});

describe("billing/checkout release hash gate (Sprint 17)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const withHashes = (release: unknown, approved: unknown) =>
    gateAdminClient(
      { data: { id: PID, creator_id: OWNER_ID, release_sha256: release }, error: null },
      { data: givenConsents().map((c) => (c.kind === "C2_release_approval" ? { ...c, document_sha256: approved } : c)), error: null },
    );

  it("permits checkout when the C2 head approved the current release (case-insensitive)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    adminModule.mockAdminClient = withHashes(RELEASE_SHA.toUpperCase(), RELEASE_SHA);
    const res = await GET(request());
    expect(res.status).toBe(302);
  });

  it.each([
    ["a mismatched approval", RELEASE_SHA, "b".repeat(64)],
    ["a null release hash", null, RELEASE_SHA],
    ["a missing C2 document hash", RELEASE_SHA, undefined],
    ["an all-zero release hash", "0".repeat(64), "0".repeat(64)],
    ["a non-hex release hash", "z".repeat(64), "z".repeat(64)],
  ])("fails closed with 403 on %s", async (_label, release, approved) => {
    vi.stubEnv("VERCEL_ENV", "preview");
    adminModule.mockAdminClient = withHashes(release, approved);
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("release hash mismatch") });
  });

  it("uses the C2 chain HEAD: a superseded approval of the current release does not count", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const consents = [
      ...givenConsents().filter((c) => c.kind !== "C2_release_approval"),
      { id: "c2-old", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: null, document_sha256: RELEASE_SHA },
      { id: "c2-new", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: "c2-old", document_sha256: "b".repeat(64) },
    ];
    adminModule.mockAdminClient = gateAdminClient(undefined, { data: consents, error: null });
    const res = await GET(request());
    expect(res.status).toBe(403);
  });
});
