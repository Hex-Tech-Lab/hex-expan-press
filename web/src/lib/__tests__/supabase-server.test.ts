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
const createClientMock = vi.fn(() => ({ auth: { getUser: getUserMock } }));
const createServerClientMock = vi.fn(() => ({ auth: { getSession: getSessionMock } }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: ((...args: unknown[]) => createClientMock(...(args as []))) as never,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: ((...args: unknown[]) => createServerClientMock(...(args as []))) as never,
}));

function makeTestJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from("test-signature").toString("base64url");
  return `${header}.${body}.${sig}`;
}

const TEST_SUB_UUID = "57596c19-c550-4bde-b17a-e87b86d005c5";

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

  it("verifies session locally with valid JWT when token has >60s until expiry (0 getUser network calls)", async () => {
    setCookie("sb-portal-auth", "valid-local-token");
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = makeTestJwt({
      sub: TEST_SUB_UUID,
      aud: "authenticated",
      exp: futureExpiry,
      email: "local@expanpress.com",
    });
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: accessToken,
          expires_at: futureExpiry,
          user: { id: "unverified-user", email: "unverified@expanpress.com" },
        },
      },
    });

    const { getPortalSession } = await import("../supabase-server");
    const session = await getPortalSession();
    expect(session).not.toBeNull();
    expect(session?.user.id).toBe(TEST_SUB_UUID);
    expect(session?.user.email).toBe("local@expanpress.com");
    // Local verification succeeded without any getUser network round-trip!
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("falls back to validateJwt (getUser) when token expires within 60s", async () => {
    setCookie("sb-portal-auth", "near-expiry-token");
    const soonExpiry = Math.floor(Date.now() / 1000) + 30; // 30s remaining
    const accessToken = makeTestJwt({
      sub: TEST_SUB_UUID,
      aud: "authenticated",
      exp: soonExpiry,
      email: "near@expanpress.com",
    });
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: accessToken,
          expires_at: soonExpiry,
          user: { id: TEST_SUB_UUID, email: "near@expanpress.com" },
        },
      },
    });
    getUserMock.mockResolvedValue({ data: { user: { id: TEST_SUB_UUID, email: "near@expanpress.com" } }, error: null });

    const { getPortalSession } = await import("../supabase-server");
    const session = await getPortalSession();
    expect(session).not.toBeNull();
    expect(getUserMock).toHaveBeenCalledWith(accessToken);
  });

  it("derives user identity strictly from verified JWT payload claims rather than unverified cookie session.user", async () => {
    setCookie("sb-portal-auth", "tampered-cookie-token");
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = makeTestJwt({
      sub: TEST_SUB_UUID,
      aud: "authenticated",
      exp: futureExpiry,
      email: "creator@expanpress.com",
    });
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: accessToken,
          expires_at: futureExpiry,
          // Cookie has unverified/tampered identity
          user: { id: "attacker-id", email: "attacker@spoofed.com" },
        },
      },
    });

    const { getPortalSession } = await import("../supabase-server");
    const session = await getPortalSession();
    expect(session).not.toBeNull();
    expect(session?.user.id).toBe(TEST_SUB_UUID);
    expect(session?.user.email).toBe("creator@expanpress.com");
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("falls back to validateJwt (getUser) when JWT payload has non-UUID sub or wrong aud", async () => {
    setCookie("sb-portal-auth", "bad-claims-token");
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const badToken = makeTestJwt({
      sub: "not-a-valid-uuid",
      aud: "authenticated",
      exp: futureExpiry,
    });
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: badToken,
          expires_at: futureExpiry,
        },
      },
    });
    getUserMock.mockResolvedValue({ data: { user: { id: "u-online-fallback" } }, error: null });

    const { getPortalSession } = await import("../supabase-server");
    const session = await getPortalSession();
    expect(session).not.toBeNull();
    expect(getUserMock).toHaveBeenCalledWith(badToken);
  });

  it("falls back to validateJwt (getUser) when token is malformed", async () => {
    setCookie("sb-portal-auth", "malformed-jwt");
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: "not-a-valid-jwt",
        },
      },
    });
    getUserMock.mockResolvedValue({ data: { user: { id: "u-online-fallback" } }, error: null });

    const { getPortalSession } = await import("../supabase-server");
    const session = await getPortalSession();
    expect(session).not.toBeNull();
    expect(getUserMock).toHaveBeenCalledWith("not-a-valid-jwt");
  });
});
