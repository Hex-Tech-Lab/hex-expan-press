// Authorization regression tests for web/src/lib/supabase-server.ts
// (qa-intel high-severity rule: auth-bearing changes need sibling tests).
//
// Wave 5 contract: the ssr HttpOnly cookie session is the ONLY auth path —
// the legacy `sb_session` JWT bridge is retired.
// Branches covered:
//   1. No ssr-format cookie → null (fail-closed), no network call.
//   2. A non-ssr cookie (e.g. the retired `sb_session`) → still null.
//   3. ssr cookie present but malformed → null (fail-closed).
//   4. Valid ssr session → user validated via getUser against the auth
//      server, queries run under the user's Authorization header (RLS).
//   5. Session token rejected by getUser → null (fail-closed).
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserMock = vi.fn();
const getSessionMock = vi.fn();
const getClaimsMock = vi.fn();
const createClientMock = vi.fn(() => ({ auth: { getUser: getUserMock } }));
const createServerClientMock = vi.fn(() => ({ auth: { getSession: getSessionMock, getClaims: getClaimsMock } }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: ((...args: unknown[]) => createClientMock(...(args as []))) as never,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: ((...args: unknown[]) => createServerClientMock(...(args as []))) as never,
}));

const cookieStore = new Map<string, { name: string; value: string }>();
function setCookie(name: string, value: string): void {
  cookieStore.set(name, { name, value });
}

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => cookieStore.get(name),
      getAll: () => Array.from(cookieStore.values()),
      set: vi.fn(),
      delete: (name: string) => cookieStore.delete(name),
    }),
}));

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";

describe("getPortalSession (Wave 5 ssr-only authorization branches)", () => {
  beforeEach(() => {
    cookieStore.clear();
    getUserMock.mockReset();
    getSessionMock.mockReset();
    getClaimsMock.mockReset();
    createClientMock.mockClear();
    createServerClientMock.mockClear();
    vi.stubEnv("NODE_ENV", "test");
  });

  it("returns null when no ssr cookie exists (fail-closed, no network)", async () => {
    const { getPortalSession } = await import("../supabase-server");
    const result = await getPortalSession();
    expect(result).toBeNull();
    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("ignores the retired sb_session JWT cookie — ssr-only, no bridge", async () => {
    setCookie("sb_session", "legacy-bridge-jwt");
    const { getPortalSession } = await import("../supabase-server");
    const result = await getPortalSession();
    expect(result).toBeNull();
    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("fails closed when the ssr client reports no session", async () => {
    setCookie("sb-portal-auth", "some-cookie");
    getSessionMock.mockResolvedValue({ data: { session: null } });
    const { getPortalSession } = await import("../supabase-server");
    const result = await getPortalSession();
    expect(result).toBeNull();
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("validates the ssr session server-side and authorizes queries under it", async () => {
    setCookie("sb-portal-auth", "valid-ssr-cookie");
    const accessToken = "sample-access-value";
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: accessToken } },
    });
    getUserMock.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.c" } }, error: null });
    const { getPortalSession } = await import("../supabase-server");
    const session = await getPortalSession();
    expect(session).not.toBeNull();
    expect(session?.user.id).toBe("u1");
    // getUser validates against the auth server — with the session value.
    expect(getUserMock).toHaveBeenCalledWith(accessToken);
    // Queries run with the user's session on the Authorization header (RLS).
    expect(createClientMock).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "test-publishable-key",
      expect.objectContaining({
        global: expect.objectContaining({
          headers: { Authorization: `Bearer ${accessToken}` },
          fetch: expect.any(Function),
        }),
      }),
    );
  });

  it("fails closed when getUser rejects the ssr session value", async () => {
    setCookie("sb-portal-auth", "valid-shape-but-revoked");
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "sample-revoked-value" } },
    });
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: "invalid claim" } });
    const { getPortalSession } = await import("../supabase-server");
    const result = await getPortalSession();
    expect(result).toBeNull();
  });

  it("verifies session locally with getClaims when token has >60s until expiry (0 getUser network calls)", async () => {
    setCookie("sb-portal-auth", "valid-local-token");
    const accessToken = "valid-unexpired-token";
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: accessToken,
          expires_at: futureExpiry,
          user: { id: "u-local-1", email: "local@expanpress.com" },
        },
      },
    });
    getClaimsMock.mockResolvedValue({
      data: { claims: { sub: "u-local-1", email: "local@expanpress.com" } },
      error: null,
    });

    const { getPortalSession } = await import("../supabase-server");
    const session = await getPortalSession();
    expect(session).not.toBeNull();
    expect(session?.user.id).toBe("u-local-1");
    // Local verification succeeded without any getUser network round-trip!
    expect(getClaimsMock).toHaveBeenCalledWith(accessToken);
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("falls back to validateJwt (getUser) when token expires within 60s", async () => {
    setCookie("sb-portal-auth", "near-expiry-token");
    const accessToken = "near-expiry-token-val";
    const soonExpiry = Math.floor(Date.now() / 1000) + 30; // 30s remaining
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: accessToken,
          expires_at: soonExpiry,
          user: { id: "u-near-1", email: "near@expanpress.com" },
        },
      },
    });
    getUserMock.mockResolvedValue({ data: { user: { id: "u-near-1", email: "near@expanpress.com" } }, error: null });

    const { getPortalSession } = await import("../supabase-server");
    const session = await getPortalSession();
    expect(session).not.toBeNull();
    expect(getUserMock).toHaveBeenCalledWith(accessToken);
  });
});
