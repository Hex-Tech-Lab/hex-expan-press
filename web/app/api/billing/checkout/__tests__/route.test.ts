import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { MatrixRouter } from "../../../../../../src/infrastructure/matrix_router/matrix_router";

const railsFile = vi.hoisted(() => ({ content: null as string | null }));

// Mock depth is 6 ups from __tests__ (route.ts resolves the same module with
// 5 ups from checkout/) — both resolve to src/infrastructure/matrix_router/matrix_router.ts.
vi.mock("../../../../../../src/infrastructure/matrix_router/matrix_router", () => ({
  MatrixRouter: { getNextProvider: vi.fn().mockResolvedValue("polar") },
}));

// The repo's data/settings rails file exists on dev machines but is never
// bundled on Vercel; by default force the serverless path (rails read fails)
// so the default-rail branch — where the fail-closed guard lives — always
// runs. Setting railsFile.content serves a configurable rails file body for
// file-source coverage.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isRailsPath = (p: unknown): boolean => typeof p === "string" && p.includes("rails.");
  return {
    ...actual,
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) =>
      isRailsPath(p) ? railsFile.content !== null : actual.existsSync(p),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (isRailsPath(args[0])) {
        if (railsFile.content === null) throw new Error("rails file unavailable in test environment");
        return railsFile.content;
      }
      return actual.readFileSync(...args);
    },
  };
});

const CHECKOUT_URL = "http://localhost:3000/api/billing/checkout?product=duane_retirement_playbook_v1";

// The handler reads request.nextUrl, so a plain Request cast is not enough —
// build a real NextRequest.
function request(): NextRequest {
  return new NextRequest(CHECKOUT_URL);
}

describe("billing/checkout launch-product default rail", () => {
  beforeEach(() => {
    // true unset (not "") — under the wave85 policy a SET-but-blank override
    // is itself a 500, which would break every default-rail test here.
    vi.stubEnv("CHECKOUT_URL_DUANE_RETIREMENT_PLAYBOOK_V1", undefined as unknown as string);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    railsFile.content = null;
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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    railsFile.content = null;
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

  it("production rails file serving a sandbox checkout_url returns 500", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    railsFile.content = JSON.stringify({
      product_id: "duane_retirement_playbook_v1",
      rails: [{ provider: "polar", weight: 100, checkout_url: "https://sandbox-api.polar.sh/x" }],
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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    railsFile.content = null;
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

  it("production rails file with checkout_url omitted / null / 42, or a null / non-object rail, returns 500 each with no location", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    for (const rails of [
      [{ provider: "polar", weight: 100 }],
      [{ provider: "polar", weight: 100, checkout_url: null }],
      [{ provider: "polar", weight: 100, checkout_url: 42 }],
      [null],
      ["not-an-object"],
    ]) {
      railsFile.content = JSON.stringify({ product_id: "duane_retirement_playbook_v1", rails });
      const res = await GET(request());
      expect(res.status, `rails=${JSON.stringify(rails)}`).toBe(500);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("production with rejecting MatrixRouter and valid live rails falls back 302 to the live url", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    railsFile.content = JSON.stringify({
      product_id: "duane_retirement_playbook_v1",
      rails: [{ provider: "polar", weight: 100, checkout_url: "https://buy.polar.sh/live-rail" }],
    });
    vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new Error("router down"));
    const res = await GET(request());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://buy.polar.sh/live-rail");
  });

  it("production with rejecting MatrixRouter and a null-url rail fails closed 500 before the router", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    railsFile.content = JSON.stringify({
      product_id: "duane_retirement_playbook_v1",
      rails: [{ provider: "polar", weight: 100, checkout_url: null }],
    });
    vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new Error("router down"));
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });
});
