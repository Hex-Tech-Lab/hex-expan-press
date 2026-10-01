import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

// Mock depth is 6 ups from __tests__ (route.ts resolves the same module with
// 5 ups from checkout/) — both resolve to src/infrastructure/matrix_router/matrix_router.ts.
vi.mock("../../../../../../src/infrastructure/matrix_router/matrix_router", () => ({
  MatrixRouter: { getNextProvider: vi.fn().mockResolvedValue("polar") },
}));

// The repo's data/settings rails file exists on dev machines but is never
// bundled on Vercel; force the serverless path (rails read fails) so the
// default-rail branch — where the fail-closed guard lives — always runs.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isRailsPath = (p: unknown): boolean => typeof p === "string" && p.includes("rails.");
  return {
    ...actual,
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) => (isRailsPath(p) ? false : actual.existsSync(p)),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (isRailsPath(args[0])) throw new Error("rails file unavailable in test environment");
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
    vi.stubEnv("CHECKOUT_URL_DUANE_RETIREMENT_PLAYBOOK_V1", "");
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
