import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

// vi.hoisted: the mock factory runs during ../route import evaluation, before
// plain module-level consts initialize (TDZ).
const { exchangeCodeForSession, verifyOtp } = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
}));

// Mock depth is 4 ups from __tests__ (route.ts resolves the same module with
// 3 ups from callback/) — both resolve to src/lib/supabase-ssr.ts.
vi.mock("../../../../src/lib/supabase-ssr", () => ({
  createSsrClient: vi.fn(async () => ({
    auth: { exchangeCodeForSession, verifyOtp },
  })),
}));

vi.spyOn(console, "error").mockImplementation(() => {});

const BASE = "http://localhost:3000/auth/callback";

// The handler reads request.url for searchParams, so a plain Request cast is
// not enough — build a real NextRequest.
function request(query = ""): NextRequest {
  return new NextRequest(query ? `${BASE}?${query}` : BASE);
}

describe("auth/callback route", () => {
  beforeEach(() => {
    exchangeCodeForSession.mockReset();
    verifyOtp.mockReset();
  });

  it("exchanges ?code= and redirects to the dashboard", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const res = await GET(request("code=abc"));
    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/creator/dashboard");
  });

  it("verifies ?token_hash with a valid type and redirects to the dashboard", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const res = await GET(request("token_hash=pkce_x&type=magiclink"));
    expect(verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: "pkce_x" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/creator/dashboard");
  });

  it("fails closed to the sign-in error redirect when verifyOtp returns an error", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "expired" } });
    const res = await GET(request("token_hash=pkce_x&type=magiclink"));
    expect(res.headers.get("location")).toContain("/creator/signin?error=auth");
  });

  it("fails closed on a disallowed type without calling verifyOtp", async () => {
    const res = await GET(request("token_hash=pkce_x&type=bogus"));
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("error=auth");
  });

  it("fails closed with no params", async () => {
    const res = await GET(request());
    expect(res.headers.get("location")).toContain("error=auth");
  });
});
