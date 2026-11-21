import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, HEAD, POST } from "../route";
import { MatrixRouter } from "../../../../../../src/infrastructure/matrix_router/matrix_router";
import { portRails } from "../../../../../../scripts/lib/heritage-rails";
import { MatrixRouterUnavailableError } from "../../../../../../src/infrastructure/matrix_router/matrix_router_errors";
import { DEFAULT_GLOBAL, GLOBAL, loadPaymentsSection } from "../../../../../../payments/src/settings_registry";

const adminModule = vi.hoisted(() => ({
  mockAdminClient: null as unknown,
}));

const registryOverride = vi.hoisted(() => ({
  sandboxCheckoutEnabled: undefined as boolean | undefined,
  polarEnabled: false,
  creemEnabled: false,
}));

vi.mock("../../../../../../payments/src/settings_registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../payments/src/settings_registry")>();
  return {
    ...actual,
    isEnabledPaymentProvider: (name: string) =>
      (name === "polar" && registryOverride.polarEnabled) ||
      (name === "creem" && registryOverride.creemEnabled) ||
      actual.isEnabledPaymentProvider(name),
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


// Mock depth is 6 ups from __tests__ (route.ts resolves the same module with
// 5 ups from checkout/) — both resolve to src/infrastructure/matrix_router/matrix_router.ts.
vi.mock("../../../../../../src/infrastructure/matrix_router/matrix_router", () => ({
  MatrixRouter: { getNextProvider: vi.fn().mockResolvedValue("paddle") },
}));

// The product id, the form the checkout page sends. A bare slug is never resolved (ADR 0065), so the default URL uses the id.
const CHECKOUT_URL = "http://localhost:3000/api/billing/checkout?product=57596c19-c550-4bde-b17a-e87b86d005c5";

// Consent-gate mock plumbing: the product lookup chains .select().eq() and then either .eq().maybeSingle()
// (id, or handle form) or .limit(2) (bare-slug ambiguity check). consents use .select().eq() (creator_id scoping).
// Sprint 15: rails come from the product_rails table —
// .select().eq().eq().order() — mocked through the same admin client.
const PID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const OWNER_ID = "c0a80101-0000-4000-8000-000000000001";
const RELEASE_SHA = "a".repeat(64);
// Fixture price for a priced product (products.price_usd). Test data only: the price source of truth is the products row, not the registry.
const PRICE_USD = "39.00";

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

// eqCalls records every (column, value) the route filters on, so a test can assert which lookup ran.
function productTableMock(products: DbResult, bareSlugMatches: DbResult = { data: [], error: null }, eqCalls: Array<[string, string]> = []) {
  const chain = {
    eq: (col: string, val: string) => {
      eqCalls.push([col, val]);
      return chain;
    },
    maybeSingle: async () => products,
    limit: async () => bareSlugMatches,
  };
  return { select: () => chain };
}

// count mirrors supabase-js { count: "exact" } — the route fails closed without it.
function withCount(consents: DbResult) {
  return { ...consents, count: Array.isArray(consents.data) ? consents.data.length : 0 };
}

// inCalls records the kinds filter the route applies to the consents read (and its count).
const inCalls: Array<[string, readonly string[]]> = [];
function consentsTableMock(consents: DbResult) {
  return {
    select: () => ({
      eq: () => ({
        in: async (col: string, vals: readonly string[]) => {
          inCalls.push([col, vals]);
          return withCount(consents);
        },
      }),
    }),
  };
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
  products: DbResult = { data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "live" }, error: null },
  consents: DbResult = { data: givenConsents(), error: null },
  rails: DbResult = { data: [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live-rail", active: true }], error: null },
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

// The checkout URL under test is a DB rail for this product now (no env override exists).
function setLiveRail(checkoutUrl: string): void {
  adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
    data: [{ provider: "paddle", weight: 100, checkout_url: checkoutUrl, active: true }],
    error: null,
  });
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
  registryOverride.sandboxCheckoutEnabled = undefined;
  registryOverride.polarEnabled = false;
  registryOverride.creemEnabled = false;
});

describe("billing/checkout DB rail in production, fail-closed without rails", () => {
  beforeEach(() => {
    // Gate must pass. DB rails start EMPTY so the no-rail case reaches the
    // 503 no_active_rail fail-closed branch; the production cases install their own rail
    // with setLiveRail, which replaces this fixture.
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, { data: [], error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed with 500 and no redirect when the live rail's checkout_url is blank in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    setLiveRail("");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects to the live rail's checkout_url in production when configured", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    setLiveRail("https://buy.paddle.com/live-test-link");
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.paddle.com/live-test-link");
  });

  it("does not serve a fallback link outside production (no rails -> 503)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("billing/checkout unified checkout_url policy", () => {
  beforeEach(() => {
    // Gate must pass and DB rails must be EMPTY so these tests reach the
    // env/legacy fallback branches they exist to cover.
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, { data: [], error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("production with no rails and no override returns 503 without a location", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("VERCEL_ENV unset with NODE_ENV=production and no rails or override returns 503", async () => {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production with a whitespace-only rail checkout_url returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    setLiveRail("   ");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production with a malformed rail checkout_url returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    setLiveRail("not a url");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production with a sandbox rail checkout_url returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    setLiveRail("https://sandbox-api.polar.sh/v1/checkout-links/x/redirect");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production with a sandbox-host rail checkout_url returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    setLiveRail("https://sandbox-api.polar.sh/x");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production DB rail redirects to its configured checkout_url (no env override)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    setLiveRail("https://buy.paddle.com/live-override");
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.paddle.com/live-override");
  });

  it("production DB rails serving a sandbox checkout_url returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "paddle", weight: 100, checkout_url: "https://sandbox-api.polar.sh/x", active: true }],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  // The launch switch decides which rails can take a buyer. A switched-off provider's active row is
  // dropped, so a product whose only active rail is switched off is refused with no redirect.
  it("an active rail for a switched-off provider (lemonsqueezy) is not offered to the buyer", async () => {
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "lemonsqueezy", weight: 100, checkout_url: "https://example.com/buy", active: true }],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("billing/checkout wave85 sandbox + raw-URL fail-closed", () => {
  beforeEach(() => {
    // true unset (not "") — a SET-but-blank override is itself a 500.
    // Gate must pass and DB rails must be EMPTY so these tests reach the
    // env/legacy fallback branches they exist to cover.
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, { data: [], error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    registryOverride.sandboxCheckoutEnabled = undefined;
    // A queued mockRejectedValueOnce can survive an early-500 test (router
    // never reached) — reset so later tests keep the default resolution.
    vi.mocked(MatrixRouter.getNextProvider).mockReset();
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
  });

  it("VERCEL_ENV unset + NODE_ENV unset + no override returns 503 (absent signals fail closed)", async () => {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("NODE_ENV", undefined as unknown as string);
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("VERCEL_ENV unset + NODE_ENV=staging + no override returns 503", async () => {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("NODE_ENV", "staging");
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("VERCEL_ENV unset + NODE_ENV=test refuses a sandbox rail when sandbox_checkout_enabled is default false (500)", async () => {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("NODE_ENV", "test");
    setLiveRail("https://sandbox-api.polar.sh/v1/checkout-links/x/redirect");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("VERCEL_ENV unset + NODE_ENV=test serves a sandbox rail on a sandbox product when sandbox_checkout_enabled is true (302)", async () => {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("NODE_ENV", "test");
    registryOverride.sandboxCheckoutEnabled = true;
    adminModule.mockAdminClient = gateAdminClient(
      { data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "sandbox" }, error: null },
      undefined,
      { data: [{ provider: "paddle", weight: 100, checkout_url: "https://sandbox-api.polar.sh/v1/checkout-links/x/redirect", active: true }], error: null },
    );
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("sandbox-api.polar.sh");
  });

  it("production rejects checkout URL override whose hostname carries a sandbox label", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    setLiveRail("https://foo-sandbox-api.example.com/x");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("production allows a host where 'sandbox' is only a substring (no sandbox label)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    setLiveRail("https://sandboxpay.example.com/x");
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://sandboxpay.example.com/x");
  });

  it("production DB rails with checkout_url omitted / null / 42, or a null / non-object rail, returns 500 each with no location", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    for (const rails of [
      [{ provider: "paddle", weight: 100, active: true }],
      [{ provider: "paddle", weight: 100, checkout_url: null, active: true }],
      [{ provider: "paddle", weight: 100, checkout_url: 42, active: true }],
      [null],
      ["not-an-object"],
    ]) {
      adminModule.mockAdminClient = gateAdminClient(undefined, undefined, { data: rails, error: null });
      const res = await GET(request());
      expect(res.status, `rails=${JSON.stringify(rails)}`).toBe(500);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("production active rail with a negative, non-finite, or non-numeric weight fails closed 500 with no location", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    for (const weight of [-1, Number.NaN, Number.POSITIVE_INFINITY, "not-a-number"]) {
      adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
        data: [{ provider: "paddle", weight, checkout_url: "https://buy.paddle.com/live-rail", active: true }],
        error: null,
      });
      const res = await GET(request());
      expect(res.status, `weight=${String(weight)}`).toBe(500);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("production with an unknown MatrixRouter error answers 500 router_unexpected_error, logs the stack, no Retry-After, no redirect", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live-rail", active: true }],
      error: null,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new Error("router down"));
      const res = await GET(request());
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ ok: false, code: "router_unexpected_error" });
      expect(res.headers.get("retry-after")).toBeNull();
      expect(res.headers.get("location")).toBeNull();
      const stackLogs = errorSpy.mock.calls.filter((args: unknown[]) => String(args[0]).includes("unexpected failure") && String(args[0]).includes("Error: router down"));
      expect(stackLogs).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("production with rejecting MatrixRouter and a null-url rail fails closed 500 before the router", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "paddle", weight: 100, checkout_url: null, active: true }],
      error: null,
    });
    vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new Error("router down"));
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("billing/checkout strict rail flags (item 5, 2026-10-15)", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(MatrixRouter.getNextProvider).mockReset();
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
  });

  it("active: \"false\" (string) is not an active rail: the product is disabled, not sold", async () => {
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live", active: "false" }],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("active: false (boolean) and active: 1 are not active rails", async () => {
    for (const active of [false, 1]) {
      adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
        data: [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live", active }],
        error: null,
      });
      const res = await GET(request());
      expect(res.status, `active=${JSON.stringify(active)}`).toBe(503);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("active: \"true\" (string) enables the rail", async () => {
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live", active: "true" }],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.paddle.com/live");
  });

  it("an active rail with a null provider fails closed 500 (no \"null\" provider string)", async () => {
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: null, weight: 100, checkout_url: "https://buy.paddle.com/live", active: true }],
      error: null,
    });
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
      "foo/bar/baz",
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

  it("rejects a product reference that fails the slug rule with 400", async () => {
    const req = new NextRequest("http://localhost:3000/api/billing/checkout?product=never-heard-of-it");
    adminModule.mockAdminClient = gateAdminClient({ data: null, error: null });
    const res = await GET(req);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  // Removed aliases (the alias map is deleted). The former duane alias is a bare slug: with no
  // matching product it answers 404 and is never rewritten to the product id.
  it("removed alias duane_retirement_playbook_v1 no longer resolves: bare slug with no match returns 404", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const eqCalls: Array<[string, string]> = [];
    adminModule.mockAdminClient = {
      from: (table: string) => {
        if (table === "products") return productTableMock({ data: null, error: null }, { data: [], error: null }, eqCalls);
        throw new Error(`table ${table} must not be queried for an unresolved alias`);
      },
    };
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=duane_retirement_playbook_v1"));
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(eqCalls).toEqual([["slug", "duane_retirement_playbook_v1"]]);
  });

  // The former hyphenated alias never reaches the lookup: the identifier rule (no hyphens) refuses it
  // with 400 before any DB query, the same as any other non-conforming reference.
  it("removed alias retirearly500k-500k-playbook is refused by the identifier rule before any DB lookup (400)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    adminModule.mockAdminClient = {
      from: () => {
        throw new Error("DB must not be queried for a non-conforming product reference");
      },
    };
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=retirearly500k-500k-playbook"));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it.each(["__proto__", "toString", "hasOwnProperty", "some-new-book"])(
    "rejects product reference %s before any DB lookup (fails the identifier rule)",
    async (slug) => {
      vi.stubEnv("VERCEL_ENV", "preview");
      adminModule.mockAdminClient = {
        from: () => {
          throw new Error("DB must not be queried for an invalid product reference");
        },
      };
      const res = await GET(new NextRequest(`http://localhost:3000/api/billing/checkout?product=${slug}`));
      expect(res.status).toBe(400);
    },
  );

  it("a bare slug matching two creators' products answers 409 product_slug_ambiguous and never resolves", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const eqCalls: Array<[string, string]> = [];
    adminModule.mockAdminClient = {
      from: (table: string) => {
        if (table === "products") {
          return productTableMock({ data: null, error: null }, { data: [{ id: "p-a" }, { id: "p-b" }], error: null }, eqCalls);
        }
        return consentsTableMock({ data: givenConsents(), error: null });
      },
    };
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=constructor"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "product_slug_ambiguous" });
    expect(res.headers.get("location")).toBeNull();
    expect(eqCalls).toEqual([["slug", "constructor"]]);
  });

  it("a bare slug matching exactly one product answers 400 product_ref_requires_handle and never resolves", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    adminModule.mockAdminClient = {
      from: (table: string) => {
        if (table === "products") {
          return productTableMock({ data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "live" }, error: null }, { data: [{ id: PID }], error: null });
        }
        return consentsTableMock({ data: givenConsents(), error: null });
      },
    };
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=some_new_book"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "product_ref_requires_handle" });
    expect(res.headers.get("location")).toBeNull();
  });

  it("a bare slug with no matching product answers 404 product_not_found", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    adminModule.mockAdminClient = gateAdminClient({ data: null, error: null });
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=some_new_book"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "product_not_found" });
  });

  it("resolves the handle form <handle>/<product_slug>, filtering the product by its creator's handle", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const eqCalls: Array<[string, string]> = [];
    adminModule.mockAdminClient = {
      from: (table: string) => {
        if (table === "products") {
          return productTableMock({ data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "live" }, error: null }, undefined, eqCalls);
        }
        if (table === "product_rails") {
          return railsTableMock({ data: [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live-rail", active: true }], error: null });
        }
        return consentsTableMock({ data: givenConsents(), error: null });
      },
    };
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=retirearly500k%2F500k_playbook"));
    expect(res.status).toBe(302);
    expect(eqCalls).toEqual([["slug", "500k_playbook"], ["creators.handle", "retirearly500k"]]);
  });

  it("a handle form with no matching creator product answers 404 and never resolves another creator's product", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    adminModule.mockAdminClient = gateAdminClient({ data: null, error: null });
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=nobody_here%2Fsome_book"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "product_not_found" });
    expect(res.headers.get("location")).toBeNull();
  });

  it("fails closed with 500 when the resolved product has no owner", async () => {
    adminModule.mockAdminClient = gateAdminClient({ data: { id: PID, creator_id: null, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "live" }, error: null });
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
                return { in: async () => withCount({ data: givenConsents(), error: null }) };
              },
            }),
          };
        }
        if (table === "product_rails") {
          return railsTableMock({ data: [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live-rail", active: true }], error: null });
        }
        return productTableMock({ data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "live" }, error: null });
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
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/from-db", active: true }],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.paddle.com/from-db");
  });

  it("returns 503 when rails are configured but ALL inactive — the database disable defeats env/legacy fallback", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/from-db", active: false }],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("serves the DB rail when SOME configured rails are active (inactive ones excluded from routing)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [
        { provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live-from-db", active: true },
        { provider: "paddle", weight: 50, checkout_url: "https://sandbox-api.polar.sh/inactive", active: false },
      ],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.paddle.com/live-from-db");
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

  it("returns 503 when the DB has no rails rows (no env fallback)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, { data: [], error: null });
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("returns 404 for an unknown product with no DB rails, no env override, and no legacy mapping", async () => {
    const req = new NextRequest("http://localhost:3000/api/billing/checkout?product=some_other_product");
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = {
      from: (table: string) => {
        if (table === "products") {
          return productTableMock({ data: { id: "11111111-1111-1111-1111-111111111111", creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "live" }, error: null });
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

  it("importer skips a sandbox rail, leaving 0 rows, so checkout is 503 (no CHECKOUT_URL_<PRODUCT> fallback)", async () => {
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
        if (table === "products") return productTableMock({ data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "live" }, error: null });
        return consentsTableMock({ data: givenConsents(), error: null });
      },
    };

    await portRails(
      store as never,
      "sandboxed-book",
      PID,
      [{ provider: "paddle", weight: 1, checkout_url: "https://sandbox-api.polar.sh/v1/checkout-links/x/redirect" }],
      false,
    );
    expect(railRows).toHaveLength(0);

    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("CHECKOUT_URL_SANDBOXED_BOOK", "https://buy.paddle.com/live-sandboxed-book");
    adminModule.mockAdminClient = store;
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=57596c19-c550-4bde-b17a-e87b86d005c5"));
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("importer aborts on a malformed checkout_url and ignores stray rail fields", async () => {
    const railRows: Array<Record<string, unknown>> = [];
    const store = { from: () => ({ upsert: async (row: Record<string, unknown>) => (railRows.push(row), { error: null }) }) };
    await expect(
      portRails(store as never, "bad-book", PID, [{ provider: "paddle", weight: 1, checkout_url: "not a url" }], false),
    ).rejects.toThrow(/malformed checkout_url/);
    const stray = { provider: "paddle", weight: 1, checkout_url: "https://buy.paddle.com/x", product_id: "other" };
    await portRails(store as never, "stray-book", PID, [stray], false);
    expect(railRows).toEqual([{ product_id: PID, provider: "paddle", weight: 1, checkout_url: "https://buy.paddle.com/x", active: true }]);
  });

  it("importer still ports a live rail as active", async () => {
    const railRows: Array<Record<string, unknown>> = [];
    const store = { from: () => ({ upsert: async (row: Record<string, unknown>) => (railRows.push(row), { error: null }) }) };
    await portRails(store as never, "live-book", PID, [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live" }], false);
    expect(railRows).toEqual([{ product_id: PID, provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live", active: true }]);
  });
});

describe("billing/checkout release hash gate (Sprint 17)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const withHashes = (release: unknown, approved: unknown) =>
    gateAdminClient(
      { data: { id: PID, creator_id: OWNER_ID, release_sha256: release, price_usd: PRICE_USD, checkout_mode: "live" }, error: null },
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

describe("billing/checkout consent read is narrowed to the gate kinds", () => {
  it("filters the consents read and its count to C1, C2 and C3 only", async () => {
    inCalls.length = 0;
    adminModule.mockAdminClient = gateAdminClient();
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(inCalls).toEqual([["kind", ["C1_data_accuracy", "C2_release_approval", "C3_revenue_split"]]]);
  });
});

describe("billing/checkout launch state + complete consent history (Sprint 17)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    registryOverride.sandboxCheckoutEnabled = undefined;
  });

  const withMode = (mode: unknown) =>
    gateAdminClient({ data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: mode }, error: null });

  it.each(["gated", "paddle", null, undefined, "LIVE"])("fails closed with 403 when checkout_mode is %s", async (mode) => {
    vi.stubEnv("VERCEL_ENV", "preview");
    adminModule.mockAdminClient = withMode(mode);
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not launched") });
  });

  it("settings registry defaults sandbox_checkout_enabled to false and fails closed on invalid values", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(DEFAULT_GLOBAL.payments.sandbox_checkout_enabled).toBe(false);
      expect(GLOBAL.payments.sandbox_checkout_enabled).toBe(false);
      expect(loadPaymentsSection(undefined).sandbox_checkout_enabled).toBe(false);
      expect(loadPaymentsSection({}).sandbox_checkout_enabled).toBe(false);
      expect(loadPaymentsSection({ sandbox_checkout_enabled: "true" }).sandbox_checkout_enabled).toBe(false);
      expect(loadPaymentsSection({ sandbox_checkout_enabled: 1 }).sandbox_checkout_enabled).toBe(false);
      expect(warn).toHaveBeenCalled();
      expect(loadPaymentsSection({ sandbox_checkout_enabled: true }).sandbox_checkout_enabled).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses checkout_mode=sandbox on VERCEL_ENV=preview when setting is default false (OWASP A04)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    adminModule.mockAdminClient = withMode("sandbox");
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses checkout_mode=sandbox and sandbox rail host on VERCEL_ENV=preview when setting is explicitly false", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    registryOverride.sandboxCheckoutEnabled = false;
    adminModule.mockAdminClient = withMode("sandbox");
    const modeRes = await GET(request());
    expect(modeRes.status).toBe(403);
    expect(modeRes.headers.get("location")).toBeNull();

    setLiveRail("https://sandbox-api.polar.sh/v1/checkout-links/x/redirect");
    const urlRes = await GET(request());
    expect(urlRes.status).toBe(500);
    expect(urlRes.headers.get("location")).toBeNull();
  });

  it("accepts checkout_mode=sandbox only with a sandbox rail host on VERCEL_ENV=preview when setting is true, and rejects live rail mismatch (F-03)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "production");
    registryOverride.sandboxCheckoutEnabled = true;
    adminModule.mockAdminClient = withMode("sandbox");
    const modeRes = await GET(request());
    expect(modeRes.status).toBe(500);
    expect(modeRes.headers.get("location")).toBeNull();

    adminModule.mockAdminClient = gateAdminClient(
      { data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "sandbox" }, error: null },
      undefined,
      { data: [{ provider: "paddle", weight: 100, checkout_url: "https://sandbox-api.polar.sh/v1/checkout-links/x/redirect", active: true }], error: null },
    );
    const urlRes = await GET(request());
    expect(urlRes.status).toBe(302);
    expect(urlRes.headers.get("location")).toBe("https://sandbox-api.polar.sh/v1/checkout-links/x/redirect");
  });

  it("rejects checkout_mode=sandbox and sandbox rail host in production even when setting is true", async () => {
    registryOverride.sandboxCheckoutEnabled = true;

    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = withMode("sandbox");
    const vercelProdModeRes = await GET(request());
    expect(vercelProdModeRes.status).toBe(403);
    expect(vercelProdModeRes.headers.get("location")).toBeNull();

    setLiveRail("https://sandbox-api.polar.sh/v1/checkout-links/x/redirect");
    const vercelProdUrlRes = await GET(request());
    expect(vercelProdUrlRes.status).toBe(500);
    expect(vercelProdUrlRes.headers.get("location")).toBeNull();

    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("NODE_ENV", "production");
    adminModule.mockAdminClient = withMode("sandbox");
    const nodeProdModeRes = await GET(request());
    expect(nodeProdModeRes.status).toBe(403);
    expect(nodeProdModeRes.headers.get("location")).toBeNull();

    setLiveRail("https://sandbox-api.polar.sh/v1/checkout-links/x/redirect");
    const nodeProdUrlRes = await GET(request());
    expect(nodeProdUrlRes.status).toBe(500);
    expect(nodeProdUrlRes.headers.get("location")).toBeNull();
  });

  it.each([
    ["truncated (count exceeds rows)", 5000],
    ["missing count", undefined],
  ])("fails closed with 500 when the consent history is %s", async (_label, count) => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const client = gateAdminClient();
    adminModule.mockAdminClient = {
      from: (table: string) =>
        table === "consents"
          ? { select: () => ({ eq: () => ({ in: async () => ({ data: givenConsents(), error: null, count }) }) }) }
          : client.from(table),
    };
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it.each([
    ["count exceeds rows", 5000],
    ["count is less than rows", 1],
  ])("fails closed with 500 and logs incomplete consent history when %s", async (_label, count) => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = gateAdminClient();
      adminModule.mockAdminClient = {
        from: (table: string) =>
          table === "consents"
            ? { select: () => ({ eq: () => ({ in: async () => ({ data: givenConsents(), error: null, count }) }) }) }
            : client.from(table),
      };
      const res = await GET(request());
      expect(res.status).toBe(500);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toEqual({ ok: false, error: "Checkout consent verification failed" });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("incomplete consent history"));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("billing/checkout attribution forwarding (Sprint 17 P3)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // reference_id forwarding was Polar-only; Polar is no longer routable (PR 102), so no
  // provider forwards attribution through the link. Paddle reads custom_data, not the link query.
  it("does not add reference_id to a Paddle rail, whatever src the buyer arrived with", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("paddle");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "paddle", weight: 100, checkout_url: "https://pay.paddle.io/checkout/x", active: true }],
      error: null,
    });
    const res = await GET(new NextRequest(`${CHECKOUT_URL}&src=ig`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://pay.paddle.io/checkout/x");
  });
});

describe("billing/checkout fail-closed without rails, and Polar never routes (PR 102)", () => {
  beforeEach(() => {
    vi.mocked(MatrixRouter.getNextProvider).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 503 with no location when there are no rails, even with a CHECKOUT_URL override set", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("CHECKOUT_URL_DUANE_RETIREMENT_PLAYBOOK_V1", "https://buy.paddle.com/override-must-not-route");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, { data: [], error: null });
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(MatrixRouter.getNextProvider).not.toHaveBeenCalled();
  });

  it("returns 503 and never calls the router when the only active rail is Polar", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-only-polar", active: true }],
      error: null,
    });
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(MatrixRouter.getNextProvider).not.toHaveBeenCalled();
  });

  it("routes to the Paddle rail, never the Polar rail, when both are configured", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [
        { provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-polar", active: true },
        { provider: "paddle", weight: 1, checkout_url: "https://buy.paddle.com/live-paddle", active: true },
      ],
      error: null,
    });
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("paddle");
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.paddle.com/live-paddle");
  });
});

describe("billing/checkout matrix router: every rail marked down (Argon F-16)", () => {
  beforeEach(() => {
    adminModule.mockAdminClient = gateAdminClient();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.mocked(MatrixRouter.getNextProvider).mockReset();
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers 503 rails_unavailable with Retry-After and never redirects to a rail the breaker has taken out", async () => {
    vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new MatrixRouterUnavailableError("payments", PID));
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "rails_unavailable" });
    expect(res.headers.get("retry-after")).toBe(String(GLOBAL.payments.checkout_router_error_retry_after_seconds));
    expect(res.headers.get("location")).toBeNull();
  });

  it("keys MatrixRouter by resolvedProduct.id for both <uuid> and <handle>/<slug>", async () => {
    vi.mocked(MatrixRouter.getNextProvider).mockClear();

    const uuidRes = await GET(new NextRequest(`http://localhost:3000/api/billing/checkout?product=${PID}`));
    expect(uuidRes.status).toBe(302);

    const handleRes = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=retirearly500k%2F500k_playbook"));
    expect(handleRes.status).toBe(302);

    expect(vi.mocked(MatrixRouter.getNextProvider).mock.calls.map((c) => c[1])).toEqual([PID, PID]);
  });
});

describe("billing/checkout HEAD handler", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live-rail", active: true }],
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the same status and redirect headers as GET with an empty body", async () => {
    const getRes = await GET(request());
    const headRes = await HEAD(new NextRequest(CHECKOUT_URL, { method: "HEAD" }));

    expect(headRes.status).toBe(getRes.status);
    expect(headRes.status).toBe(302);
    expect(headRes.headers.get("location")).toBe(getRes.headers.get("location"));
    expect(headRes.headers.get("cache-control")).toBe(getRes.headers.get("cache-control"));
    expect(headRes.body).toBeNull();
    expect(await headRes.text()).toBe("");
  });

  it("mirrors error status codes (400, 403, 404, 500, 503) with empty body on HEAD (F-11)", async () => {
    const badEmailRes = await HEAD(new NextRequest(`${CHECKOUT_URL}&buyer_email=not-an-email`, { method: "HEAD" }));
    expect(badEmailRes.status).toBe(400);
    expect(await badEmailRes.text()).toBe("");

    const blockedCountryRes = await HEAD(new NextRequest(CHECKOUT_URL, { method: "HEAD", headers: { "x-vercel-ip-country": "DE" } }));
    expect(blockedCountryRes.status).toBe(403);
    expect(await blockedCountryRes.text()).toBe("");

    adminModule.mockAdminClient = gateAdminClient({ data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "gated" }, error: null });
    const gatedRes = await HEAD(new NextRequest(CHECKOUT_URL, { method: "HEAD" }));
    expect(gatedRes.status).toBe(403);
    expect(await gatedRes.text()).toBe("");

    adminModule.mockAdminClient = gateAdminClient({ data: null, error: null });
    const notFoundRes = await HEAD(new NextRequest(CHECKOUT_URL, { method: "HEAD" }));
    expect(notFoundRes.status).toBe(404);
    expect(await notFoundRes.text()).toBe("");

    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "paddle", weight: 100, checkout_url: "http://buy.paddle.com/insecure", active: true }],
      error: null,
    });
    const badRailRes = await HEAD(new NextRequest(CHECKOUT_URL, { method: "HEAD" }));
    expect(badRailRes.status).toBe(500);
    expect(await badRailRes.text()).toBe("");

    adminModule.mockAdminClient = gateAdminClient();
    vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new MatrixRouterUnavailableError("payments", PID));
    const downRes = await HEAD(new NextRequest(CHECKOUT_URL, { method: "HEAD" }));
    expect(downRes.status).toBe(503);
    expect(await downRes.text()).toBe("");
  });

  it("forwards buyer params on HEAD for Polar and Creem rails with empty body (F-11)", async () => {
    registryOverride.polarEnabled = true;
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("polar");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-polar", active: true }],
      error: null,
    });
    const polarHead = await HEAD(new NextRequest(`${CHECKOUT_URL}&buyer_email=ann%40example.com&buyer_consent=true`, { method: "HEAD" }));
    expect(polarHead.status).toBe(302);
    expect(new URL(polarHead.headers.get("location")!).searchParams.get("customer_email")).toBe("ann@example.com");
    expect(await polarHead.text()).toBe("");

    registryOverride.creemEnabled = true;
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("creem");
    adminModule.mockAdminClient = gateAdminClient(
      { data: { id: PID, store_product_id: "store_book_1", creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "live", creators: { handle: "duane" } }, error: null },
      undefined,
      { data: [{ provider: "creem", weight: 100, checkout_url: "https://creem.io/payment/prod_live", active: true }], error: null },
    );
    const creemHead = await HEAD(new NextRequest(`${CHECKOUT_URL}&buyer_email=ann%40example.com&buyer_consent=true`, { method: "HEAD" }));
    expect(creemHead.status).toBe(302);
    const loc = new URL(creemHead.headers.get("location")!);
    expect(loc.searchParams.get(`metadata[${GLOBAL.delivery.buyer_consent_metadata_key}]`)).toBe("true");
    expect(loc.searchParams.get("success_url")).toBe(`${GLOBAL.delivery.download_origin}/books/duane/thanks`);
    expect(await creemHead.text()).toBe("");
  });
});

describe("billing/checkout additional defensive and lookup branches", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.mocked(MatrixRouter.getNextProvider).mockReset();
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    registryOverride.polarEnabled = false;
    registryOverride.sandboxCheckoutEnabled = undefined;
  });

  it("returns 400 when product query parameter is absent", async () => {
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "Missing product parameter in URL" });
  });

  it("returns 404 product_not_found when UUID lookup finds no row", async () => {
    adminModule.mockAdminClient = gateAdminClient({ data: null, error: null });
    const res = await GET(request());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "product_not_found" });
  });

  it("returns 500 when <handle>/<slug> product lookup errors", async () => {
    adminModule.mockAdminClient = gateAdminClient({ data: null, error: { message: "handle lookup failed" } });
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=creator_handle%2Fsome_book"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "Checkout consent verification failed" });
  });

  it("returns 500 when bare slug lookup errors", async () => {
    adminModule.mockAdminClient = {
      from: (table: string) => {
        if (table === "products") {
          return productTableMock({ data: null, error: null }, { data: null, error: { message: "slug lookup failed" } });
        }
        return {};
      },
    };
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=some_book"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "Checkout consent verification failed" });
  });

  it("returns 404 product_not_found when bare slug lookup returns null matches", async () => {
    adminModule.mockAdminClient = {
      from: (table: string) => {
        if (table === "products") {
          return productTableMock({ data: null, error: null }, { data: null, error: null });
        }
        return {};
      },
    };
    const res = await GET(new NextRequest("http://localhost:3000/api/billing/checkout?product=some_book"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "product_not_found" });
  });

  it("rejects non-https rail checkout_url with 500", async () => {
    setLiveRail("http://buy.paddle.com/insecure");
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "Checkout is not configured" });
  });

  it("fails closed with 500 when consents query returns null data with positive count", async () => {
    const client = gateAdminClient();
    adminModule.mockAdminClient = {
      from: (table: string) =>
        table === "consents"
          ? { select: () => ({ eq: () => ({ in: async () => ({ data: null, error: null, count: 1 }) }) }) }
          : client.from(table),
    };
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "Checkout consent verification failed" });
  });

  it("fails closed with 403 when consents query returns null data with count 0", async () => {
    const client = gateAdminClient();
    adminModule.mockAdminClient = {
      from: (table: string) =>
        table === "consents"
          ? { select: () => ({ eq: () => ({ in: async () => ({ data: null, error: null, count: 0 }) }) }) }
          : client.from(table),
    };
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "Checkout forbidden: required creator consents are not active" });
  });

  it("returns 503 when product_rails query returns null data", async () => {
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, { data: null, error: null });
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });

  it("fails closed with 500 when consent verification throws an unexpected exception", async () => {
    adminModule.mockAdminClient = {
      from: () => {
        throw new Error("unexpected db client failure");
      },
    };
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "Checkout consent verification failed" });
  });

  it("answers 500 router_unexpected_error and never picks a rail by weight when MatrixRouter throws an unknown error", async () => {
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [
        { provider: "paddle", weight: 10, checkout_url: "https://buy.paddle.com/low-weight", active: true },
        { provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/high-weight", active: true },
      ],
      error: null,
    });
    vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new Error("router down"));
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, code: "router_unexpected_error" });
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("appends reference_id when a Polar rail is enabled in settings and selected", async () => {
    registryOverride.polarEnabled = true;
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("polar");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-polar", active: true }],
      error: null,
    });
    const res = await GET(new NextRequest(`${CHECKOUT_URL}&src=ig`));
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const parsed = new URL(location!);
    expect(parsed.origin + parsed.pathname).toBe("https://buy.polar.sh/live-polar");
    expect(parsed.searchParams.get("reference_id")).toBeTruthy();
  });
});

// Buyer email and consent from the product page's email step. Each provider receives only what its checkout link documents:
// Polar customer_email, Creem a metadata key, Paddle user_email (its hosted checkout parameter). Paddle's hosted link documents
// no consent or success_url parameter, so neither is added there.
describe("billing/checkout buyer email and consent (product page email step)", () => {
  const BUYER = "buyer_email=ann%40example.com&buyer_consent=true";

  beforeEach(() => {
    adminModule.mockAdminClient = gateAdminClient();
  });

  it("answers 400 for a malformed buyer email before any product lookup", async () => {
    const res = await GET(new NextRequest(`${CHECKOUT_URL}&buyer_email=not-an-email`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "Invalid buyer email", code: "buyer_email_invalid" });
    expect(res.headers.get("location")).toBeNull();
  });

  it("answers 400 for a consent value other than true or false", async () => {
    const res = await GET(new NextRequest(`${CHECKOUT_URL}&buyer_consent=yes`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "Invalid buyer consent", code: "buyer_consent_invalid" });
  });

  it("prefills customer_email on a Polar checkout link", async () => {
    registryOverride.polarEnabled = true;
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("polar");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-polar", active: true }],
      error: null,
    });
    const res = await GET(new NextRequest(`${CHECKOUT_URL}&${BUYER}`));
    expect(res.status).toBe(302);
    const parsed = new URL(res.headers.get("location")!);
    expect(parsed.origin + parsed.pathname).toBe("https://buy.polar.sh/live-polar");
    expect(parsed.searchParams.get("customer_email")).toBe("ann@example.com");
  });

  it("an unknown router error on a Polar rail answers 500 router_unexpected_error: no redirect and no buyer email is sent to a provider", async () => {
    registryOverride.polarEnabled = true;
    vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new Error("router down"));
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-polar", active: true }],
      error: null,
    });
    const res = await GET(new NextRequest(`${CHECKOUT_URL}&${BUYER}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "router_unexpected_error" });
    expect(res.headers.get("location")).toBeNull();
  });

  it("records consent as checkout metadata on a Creem link and sends no email there", async () => {
    registryOverride.creemEnabled = true;
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("creem");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "creem", weight: 100, checkout_url: "https://creem.io/payment/prod_live", active: true }],
      error: null,
    });
    const res = await GET(new NextRequest(`${CHECKOUT_URL}&buyer_email=ann%40example.com&buyer_consent=false`));
    expect(res.status).toBe(302);
    const parsed = new URL(res.headers.get("location")!);
    expect(parsed.searchParams.get(`metadata[${GLOBAL.delivery.buyer_consent_metadata_key}]`)).toBe("false");
    expect(parsed.searchParams.get("customer_email")).toBeNull();
    expect(parsed.searchParams.get("reference_id")).toBeNull();
  });

  it("prefills user_email on the Paddle hosted checkout link and adds no other buyer parameter", async () => {
    const res = await GET(new NextRequest(`${CHECKOUT_URL}&${BUYER}`));
    expect(res.status).toBe(302);
    const parsed = new URL(res.headers.get("location")!);
    expect(parsed.origin + parsed.pathname).toBe("https://buy.paddle.com/live-rail");
    expect([...parsed.searchParams.keys()]).toEqual(["user_email"]);
    expect(parsed.searchParams.get("user_email")).toBe("ann@example.com");
  });

  it("leaves the Paddle redirect exactly as configured when the buyer gave no email", async () => {
    const res = await GET(new NextRequest(`${CHECKOUT_URL}&buyer_consent=true`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.paddle.com/live-rail");
  });

  it("sets Creem metadata[order_ref], metadata[product_id], and success_url without overwriting an existing success_url (F-04, F-07)", async () => {
    registryOverride.creemEnabled = true;
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("creem");
    adminModule.mockAdminClient = gateAdminClient(
      { data: { id: PID, store_product_id: "store_book_1", creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "live", creators: { handle: "duane" } }, error: null },
      undefined,
      { data: [{ provider: "creem", weight: 100, checkout_url: "https://creem.io/payment/prod_live", active: true }], error: null },
    );
    const res = await GET(new NextRequest(`${CHECKOUT_URL}&src=ig&dub_id=d1&buyer_email=ann%40example.com&buyer_consent=true`));
    expect(res.status).toBe(302);
    const parsed = new URL(res.headers.get("location")!);
    expect(parsed.searchParams.get("metadata[order_ref]")).toBe("ig:d1");
    expect(parsed.searchParams.get("metadata[product_id]")).toBe("store_book_1");
    expect(parsed.searchParams.get("success_url")).toBe(`${GLOBAL.delivery.download_origin}/books/duane/thanks`);

    adminModule.mockAdminClient = gateAdminClient(
      { data: { id: PID, store_product_id: null, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "live", creators: { handle: "duane" } }, error: null },
      undefined,
      { data: [{ provider: "creem", weight: 100, checkout_url: "https://creem.io/payment/prod_live?success_url=https%3A%2F%2Fexpanpress.com%2Fbooks%2Fcustom", active: true }], error: null },
    );
    const presetRes = await GET(new NextRequest(`${CHECKOUT_URL}&buyer_email=ann%40example.com&buyer_consent=true`));
    const presetUrl = new URL(presetRes.headers.get("location")!);
    expect(presetUrl.searchParams.get("metadata[product_id]")).toBe(PID);
    expect(presetUrl.searchParams.get("success_url")).toBe("https://expanpress.com/books/custom");
  });
});

describe("billing/checkout POST single-hop form & JSON (F-07 Option A)", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "production");
    adminModule.mockAdminClient = gateAdminClient();
    vi.mocked(MatrixRouter.getNextProvider).mockReset();
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function postForm(fields: Record<string, string>, headers: Record<string, string> = {}) {
    return new NextRequest("http://localhost:3000/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it("returns 303 See Other with Cache-Control: no-store on valid form POST", async () => {
    const res = await POST(postForm({
      product: PID,
      buyer_email: "ann@example.com",
      buyer_email_confirm: "ann@example.com",
      buyer_consent: "true",
      src: "ig",
    }));
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://buy.paddle.com/live-rail");
    expect(location.searchParams.get("user_email")).toBe("ann@example.com");
  });

  it("treats omitted buyer_consent checkbox on POST as false and forwards Creem metadata + order_ref + success_url", async () => {
    registryOverride.creemEnabled = true;
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("creem");
    adminModule.mockAdminClient = gateAdminClient(
      { data: { id: PID, store_product_id: "sp_1", creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "live", creators: { handle: "duane" } }, error: null },
      undefined,
      { data: [{ provider: "creem", weight: 100, checkout_url: "https://creem.io/payment/prod_live", active: true }], error: null },
    );
    const res = await POST(postForm({
      product: PID,
      buyer_email: "ann@example.com",
      buyer_email_confirm: "ann@example.com",
      src: "yt",
    }));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get(`metadata[${GLOBAL.delivery.buyer_consent_metadata_key}]`)).toBe("false");
    expect(loc.searchParams.get("metadata[order_ref]")).toBe("yt");
    expect(loc.searchParams.get("metadata[product_id]")).toBe("sp_1");
    expect(loc.searchParams.get("success_url")).toBe(`${GLOBAL.delivery.download_origin}/books/duane/thanks`);
  });

  it("supports JSON POST bodies and returns 303", async () => {
    registryOverride.polarEnabled = true;
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("polar");
    adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
      data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-polar", active: true }],
      error: null,
    });
    const res = await POST(new NextRequest("http://localhost:3000/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product: PID,
        buyer_email: "ann@example.com",
        buyer_email_confirm: "ann@example.com",
        buyer_consent: true,
        src: "ig",
      }),
    }));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("customer_email")).toBe("ann@example.com");
    expect(loc.searchParams.get("reference_id")).toBe("ig");
  });

  it("enforces buyerEmailsMatch and valid email on POST with 400", async () => {
    const mismatchRes = await POST(postForm({
      product: PID,
      buyer_email: "ann@example.com",
      buyer_email_confirm: "other@example.com",
      buyer_consent: "true",
    }));
    expect(mismatchRes.status).toBe(400);
    expect(await mismatchRes.json()).toMatchObject({ ok: false, code: "buyer_email_mismatch" });

    const invalidRes = await POST(postForm({
      product: PID,
      buyer_email: "bad",
      buyer_email_confirm: "bad",
    }));
    expect(invalidRes.status).toBe(400);
    expect(await invalidRes.json()).toMatchObject({ ok: false, code: "buyer_email_invalid" });
  });

  it("returns 200 paddle_overlay JSON when Accept: application/json is sent for a Paddle rail with paddle_price_id", async () => {
    const o = GLOBAL.payments.paddle.overlay;
    vi.stubEnv(o.client_token_env, "live_tok_route");
    vi.stubEnv(o.environment_env, "production");
    adminModule.mockAdminClient = gateAdminClient(
      {
        data: {
          id: PID,
          store_product_id: "store_book_1",
          creator_id: OWNER_ID,
          release_sha256: RELEASE_SHA, price_usd: PRICE_USD,
          checkout_mode: "live",
          paddle_price_id: "pri_live_99",
          creators: { handle: "duane" },
        },
        error: null,
      },
      undefined,
      { data: [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/live-rail", active: true }], error: null },
    );

    const res = await POST(new NextRequest("http://localhost:3000/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        product: PID,
        buyer_email: "ann@example.com",
        buyer_email_confirm: "ann@example.com",
        buyer_consent: false,
        src: "ig",
        dub_id: "dub_7",
      }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: true,
      kind: "paddle_overlay",
      payload: {
        items: [{ priceId: "pri_live_99", quantity: 1 }],
        customer: { email: "ann@example.com" },
        customData: {
          [o.order_ref_key]: "ig:dub_7",
          [o.buyer_consent_key]: "false",
        },
        settings: {
          displayMode: "overlay",
          theme: o.theme,
          locale: o.locale,
          successUrl: `${GLOBAL.delivery.download_origin}/books/duane/thanks`,
        },
      },
    });
  });

  it("returns 200 redirect JSON when Accept: application/json is sent for a non-Paddle rail (other providers keep redirect)", async () => {
    registryOverride.creemEnabled = true;
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("creem");
    adminModule.mockAdminClient = gateAdminClient(
      {
        data: {
          id: PID,
          store_product_id: "sp_creem",
          creator_id: OWNER_ID,
          release_sha256: RELEASE_SHA, price_usd: PRICE_USD,
          checkout_mode: "live",
          paddle_price_id: "pri_ignored",
          creators: { handle: "duane" },
        },
        error: null,
      },
      undefined,
      { data: [{ provider: "creem", weight: 100, checkout_url: "https://creem.io/payment/prod_live", active: true }], error: null },
    );

    const res = await POST(new NextRequest("http://localhost:3000/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        product: PID,
        buyer_email: "ann@example.com",
        buyer_email_confirm: "ann@example.com",
        buyer_consent: true,
        src: "yt",
      }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = (await res.json()) as { ok: boolean; kind: string; redirectUrl: string };
    expect(json.ok).toBe(true);
    expect(json.kind).toBe("redirect");
    const loc = new URL(json.redirectUrl);
    expect(loc.origin + loc.pathname).toBe("https://creem.io/payment/prod_live");
    expect(loc.searchParams.get(`metadata[${GLOBAL.delivery.buyer_consent_metadata_key}]`)).toBe("true");
  });
});

describe("billing/checkout F-03 test/stage/path-based sandbox guard & F-06 US-only geo gate", () => {
  beforeEach(() => {
    adminModule.mockAdminClient = gateAdminClient();
    vi.mocked(MatrixRouter.getNextProvider).mockReset();
    vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    registryOverride.sandboxCheckoutEnabled = undefined;
  });

  it.each([
    "https://creem.io/test/payment/prod_123",
    "https://www.creem.io/test/payment/prod_123",
    "https://test-api.creem.io/pay/prod_123",
    "https://api.stage.fungies.net/pay/123",
  ])("rejects %s on a live product in production (500)", async (url) => {
    vi.stubEnv("VERCEL_ENV", "production");
    setLiveRail(url);
    const res = await GET(request());
    expect(res.status).toBe(500);
  });

  it("rejects a sandbox rail on a live product even in preview when sandbox_checkout_enabled is true", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    registryOverride.sandboxCheckoutEnabled = true;
    setLiveRail("https://creem.io/test/payment/prod_123");
    const res = await GET(request());
    expect(res.status).toBe(500);
  });

  it("allows a /test/ sandbox rail on a sandbox product in preview when sandbox_checkout_enabled is true", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    registryOverride.sandboxCheckoutEnabled = true;
    adminModule.mockAdminClient = gateAdminClient(
      { data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: PRICE_USD, checkout_mode: "sandbox" }, error: null },
      undefined,
      { data: [{ provider: "paddle", weight: 100, checkout_url: "https://creem.io/test/payment/prod_123", active: true }], error: null },
    );
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://creem.io/test/payment/prod_123");
  });

  it("returns 409 product_unpriced for a sandbox product with a null price on VERCEL_ENV=preview when sandbox is enabled, with no location and no router call", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    registryOverride.sandboxCheckoutEnabled = true;
    adminModule.mockAdminClient = gateAdminClient(
      { data: { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, price_usd: null, checkout_mode: "sandbox" }, error: null },
      undefined,
      { data: [{ provider: "paddle", weight: 100, checkout_url: "https://creem.io/test/payment/prod_123", active: true }], error: null },
    );
    const res = await GET(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "product_unpriced" });
    expect(res.headers.get("location")).toBeNull();
    expect(MatrixRouter.getNextProvider).not.toHaveBeenCalled();
  });

  it("blocks non-US countries with 403 country_not_supported on GET and POST, and allows US + territories", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const getBlocked = await GET(new NextRequest(CHECKOUT_URL, { headers: { "x-vercel-ip-country": "DE" } }));
    expect(getBlocked.status).toBe(403);
    expect(await getBlocked.json()).toMatchObject({ ok: false, code: "country_not_supported" });

    const postBlocked = await POST(new NextRequest("http://localhost:3000/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-vercel-ip-country": "GB" },
      body: new URLSearchParams({ product: PID, buyer_email: "ann@example.com", buyer_email_confirm: "ann@example.com" }).toString(),
    }));
    expect(postBlocked.status).toBe(403);
    expect(await postBlocked.json()).toMatchObject({ ok: false, code: "country_not_supported" });

    for (const country of ["US", "PR", "VI", "GU", "AS", "MP"]) {
      const ok = await GET(new NextRequest(CHECKOUT_URL, { headers: { "x-vercel-ip-country": country } }));
      expect(ok.status, country).toBe(302);
    }
  });

  it("reads supports_reference_id and theme_param capabilities from PAYMENT_PROVIDERS (B-05 + checkout branding)", async () => {
    const { PAYMENT_PROVIDERS } = await import("../../../../../../payments/src/settings_registry");
    const origCreemRef = PAYMENT_PROVIDERS.creem.supports_reference_id;
    const origPolarTheme = PAYMENT_PROVIDERS.polar.theme_param;
    PAYMENT_PROVIDERS.creem.supports_reference_id = true;
    PAYMENT_PROVIDERS.polar.theme_param = "theme";
    try {
      registryOverride.creemEnabled = true;
      vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("creem");
      adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
        data: [{ provider: "creem", weight: 100, checkout_url: "https://creem.io/payment/prod_live", active: true }],
        error: null,
      });
      const creemRes = await GET(new NextRequest(`${CHECKOUT_URL}&src=ig`));
      expect(creemRes.status).toBe(302);
      const creemLoc = new URL(creemRes.headers.get("location")!);
      expect(creemLoc.searchParams.get("reference_id")).toBe("ig");
      expect(creemLoc.searchParams.get("theme")).toBe(GLOBAL.branding.theme_mode);

      registryOverride.polarEnabled = true;
      vi.mocked(MatrixRouter.getNextProvider).mockResolvedValueOnce("polar");
      adminModule.mockAdminClient = gateAdminClient(undefined, undefined, {
        data: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-polar", active: true }],
        error: null,
      });
      const polarRes = await GET(new NextRequest(`${CHECKOUT_URL}&src=ig`));
      expect(polarRes.status).toBe(302);
      const polarLoc = new URL(polarRes.headers.get("location")!);
      expect(polarLoc.searchParams.get("theme")).toBe(GLOBAL.branding.theme_mode);
    } finally {
      PAYMENT_PROVIDERS.creem.supports_reference_id = origCreemRef;
      PAYMENT_PROVIDERS.polar.theme_param = origPolarTheme;
    }
  });
});
