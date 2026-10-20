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
import { decodeAndVerifyJwt } from "../jwt-verify";
import { ASYMMETRIC_ALG_FIXTURES, MOCK_HMAC_KEY, makeTestJwt } from "./jwt-fixtures";

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
    process.env.SUPABASE_JWT_SECRET = MOCK_HMAC_KEY;
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

  it("falls back to validateJwt (getUser) when signature is signed with wrong secret (adversarial forged token)", async () => {
    setCookie("sb-portal-auth", "forged-secret-token");
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const forgedToken = makeTestJwt(
      { sub: TEST_SUB_UUID, aud: "authenticated", exp: futureExpiry, email: "victim@expanpress.com" },
      { secret: "wrong-hmac-key-fixture-32-chars-long" },
    );
    expect(decodeAndVerifyJwt(forgedToken)).toBeNull();
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: forgedToken,
          expires_at: futureExpiry,
        },
      },
    });
    // Online check fails because auth server knows the real secret and rejects forged signature
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: "invalid signature" } });

    const { getPortalSession } = await import("../supabase-server");
    const session = await getPortalSession();
    // Must fail closed (null)
    expect(session).toBeNull();
    expect(getUserMock).toHaveBeenCalledWith(forgedToken);
  });

  it("falls back to validateJwt (getUser) and rejects when payload claim is tampered with original signature", async () => {
    setCookie("sb-portal-auth", "tampered-payload-token");
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const validToken = makeTestJwt({ sub: TEST_SUB_UUID, aud: "authenticated", exp: futureExpiry });
    const [header, , sig] = validToken.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: "00000000-0000-0000-0000-000000000000", aud: "authenticated", exp: futureExpiry }),
    ).toString("base64url");
    const tamperedToken = `${header}.${tamperedPayload}.${sig}`;

    expect(decodeAndVerifyJwt(tamperedToken)).toBeNull();
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: tamperedToken,
          expires_at: futureExpiry,
        },
      },
    });
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: "signature mismatch" } });

    const { getPortalSession } = await import("../supabase-server");
    const session = await getPortalSession();
    expect(session).toBeNull();
    expect(getUserMock).toHaveBeenCalledWith(tamperedToken);
  });

  it("falls back to validateJwt (getUser) when alg is none (adversarial alg:none attack)", async () => {
    setCookie("sb-portal-auth", "none-alg-token");
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const noneToken = makeTestJwt(
      { sub: TEST_SUB_UUID, aud: "authenticated", exp: futureExpiry },
      { alg: "none", rawSignature: "" },
    );
    expect(decodeAndVerifyJwt(noneToken)).toBeNull();
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: noneToken,
          expires_at: futureExpiry,
        },
      },
    });
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: "unsupported algorithm" } });

    const { getPortalSession } = await import("../supabase-server");
    const session = await getPortalSession();
    expect(session).toBeNull();
    expect(getUserMock).toHaveBeenCalledWith(noneToken);
  });

  it.each(ASYMMETRIC_ALG_FIXTURES)(
    "%s token: rejected locally, getUser called, online auth rejects: fails closed to null",
    async (alg) => {
      setCookie("sb-portal-auth", `asym-${alg}-token`);
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
      const token = makeTestJwt({ sub: TEST_SUB_UUID, aud: "authenticated", exp: futureExpiry }, { alg });
      expect(token.split(".")[2]).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeAndVerifyJwt(token)).toBeNull();
      getSessionMock.mockResolvedValue({ data: { session: { access_token: token, expires_at: futureExpiry } } });
      getUserMock.mockResolvedValue({ data: { user: null }, error: { name: "AuthApiError", message: "invalid JWT", status: 401 } });

      const { getPortalSession } = await import("../supabase-server");
      expect(await getPortalSession()).toBeNull();
      expect(getUserMock).toHaveBeenCalledWith(token);
    },
  );

  it("fails closed to validateJwt (getUser) when SUPABASE_JWT_SECRET is missing or empty", async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    setCookie("sb-portal-auth", "no-secret-env-token");
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const validToken = makeTestJwt({ sub: TEST_SUB_UUID, aud: "authenticated", exp: futureExpiry });
    expect(decodeAndVerifyJwt(validToken)).toBeNull();
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: validToken,
          expires_at: futureExpiry,
        },
      },
    });
    getUserMock.mockResolvedValue({ data: { user: { id: TEST_SUB_UUID } }, error: null });

    const { getPortalSession } = await import("../supabase-server");
    const session = await getPortalSession();
    expect(session).not.toBeNull();
    // Without the local secret, it MUST fall back to getUser online verification
    expect(getUserMock).toHaveBeenCalledWith(validToken);
  });
});
