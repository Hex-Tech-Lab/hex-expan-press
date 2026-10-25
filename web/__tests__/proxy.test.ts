// Proxy contract tests (qa-intel security rule: the getUser session
// boundary needs a sibling regression test).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decodeAndVerifyJwt } from "../src/lib/jwt-verify";
import { ASYMMETRIC_ALG_FIXTURES, MOCK_HMAC_KEY, makeTestJwt } from "../src/lib/__tests__/jwt-fixtures";

interface CookieToSet {
  name: string;
  value: string;
  options?: Record<string, unknown>;
}

let lastCapturedOptions: {
  cookies?: {
    getAll: () => Array<{ name: string; value: string }>;
    setAll: (cookiesToSet: CookieToSet[]) => void;
  };
} | null = null;
const recordedSetAllCalls: CookieToSet[][] = [];

const getUserMock = vi.fn();
const getSessionMock = vi.fn();
const createServerClientMock = vi.fn((_url?: unknown, _key?: unknown, options?: unknown) => {
  const opts = options as typeof lastCapturedOptions;
  if (opts?.cookies) {
    lastCapturedOptions = opts;
    const originalSetAll = opts.cookies.setAll;
    opts.cookies.setAll = (cookiesToSet: CookieToSet[]) => {
      recordedSetAllCalls.push(cookiesToSet);
      return originalSetAll(cookiesToSet);
    };
  }
  return {
    auth: {
      getUser: getUserMock,
      getSession: getSessionMock,
    },
  };
});
const cookiesSetSpy = vi.fn();

// Every test gets the same stubbed environment, and it is restored after each test. The alg-gate cases
// are rejected by the header check alone, because the secret is set for every test.
beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-key");
  vi.stubEnv("SUPABASE_JWT_SECRET", MOCK_HMAC_KEY);
  vi.stubEnv("NODE_ENV", "test");
  recordedSetAllCalls.length = 0;
  lastCapturedOptions = null;
});
afterEach(() => vi.unstubAllEnvs());

vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => createServerClientMock(...(args as [])),
}));

const TEST_SUB_UUID = "57596c19-c550-4bde-b17a-e87b86d005c5";

function fakeRequest(cookieNames: string[]): unknown {
  return {
    cookies: {
      getAll: () => cookieNames.map((name) => ({ name, value: "v" })),
      set: cookiesSetSpy,
    },
    url: "http://localhost:3000/creator/dashboard",
    headers: new Headers({ "x-test": "1" }),
  };
}

describe("proxy (session refresh boundary)", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    createServerClientMock.mockClear();
    cookiesSetSpy.mockClear();
    recordedSetAllCalls.length = 0;
    lastCapturedOptions = null;
  });

  it("calls getUser (network validation) and passes the response through", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    const { proxy } = await import("../proxy");
    const response = await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(response).toBeDefined();
  });

  it("survives an auth-service outage without throwing (fail-open refresh, fail-closed pages)", async () => {
    getUserMock.mockRejectedValue(new Error("auth down"));
    const { proxy } = await import("../proxy");
    const response = await proxy(fakeRequest([]) as never);
    expect(response).toBeDefined();
  });

  it("asserts the explicit HttpOnly cookie options are passed to the ssr client", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    const { proxy } = await import("../proxy");
    await proxy(fakeRequest([]) as never);
    expect(createServerClientMock).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "test-key",
      expect.objectContaining({
        cookieOptions: expect.objectContaining({ httpOnly: true, sameSite: "lax", name: "sb-portal-auth" }),
      }),
    );
  });

  it("skips getUser network round-trip when access token has >60s remaining and valid JWT claims", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeTestJwt({ sub: TEST_SUB_UUID, aud: "authenticated", exp: futureExp });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: token, expires_at: futureExp } },
    });
    const { proxy } = await import("../proxy");
    const response = await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getSessionMock).toHaveBeenCalledTimes(1);
    expect(getUserMock).not.toHaveBeenCalled();
    expect(response).toBeDefined();
  });

  it("calls getUser to refresh when access token is within 60s of expiry", async () => {
    const nearExp = Math.floor(Date.now() / 1000) + 30;
    const token = makeTestJwt({ sub: TEST_SUB_UUID, aud: "authenticated", exp: nearExp });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: token, expires_at: nearExp } },
    });
    getUserMock.mockResolvedValue({ data: { user: { id: TEST_SUB_UUID } }, error: null });
    const { proxy } = await import("../proxy");
    await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("calls getUser to refresh when access token is expired", async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 100;
    const token = makeTestJwt({ sub: TEST_SUB_UUID, aud: "authenticated", exp: pastExp });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: token, expires_at: pastExp } },
    });
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const { proxy } = await import("../proxy");
    await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("calls getUser when token has invalid format or corrupt payload", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "corrupt.jwt.format!", expires_at: futureExp } },
    });
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const { proxy } = await import("../proxy");
    await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("calls getUser when token sub is not a valid UUID", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeTestJwt({ sub: "not-a-uuid", aud: "authenticated", exp: futureExp });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: token, expires_at: futureExp } },
    });
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const { proxy } = await import("../proxy");
    await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("calls getUser when token aud is not authenticated", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeTestJwt({ sub: TEST_SUB_UUID, aud: "anon", exp: futureExp });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: token, expires_at: futureExp } },
    });
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const { proxy } = await import("../proxy");
    await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("calls getUser when signature is signed with the wrong HMAC secret (adversarial forged token)", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const forgedToken = makeTestJwt(
      { sub: TEST_SUB_UUID, aud: "authenticated", exp: futureExp },
      { secret: "wrong-hmac-key-fixture-32-chars-long" },
    );
    expect(decodeAndVerifyJwt(forgedToken)).toBeNull();
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: forgedToken, expires_at: futureExp } },
    });
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const { proxy } = await import("../proxy");
    await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("calls getUser when payload claim is tampered with original signature (adversarial payload tampering)", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const validToken = makeTestJwt({ sub: TEST_SUB_UUID, aud: "authenticated", exp: futureExp });
    const [header, , sig] = validToken.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: "00000000-0000-0000-0000-000000000000", aud: "authenticated", exp: futureExp }),
    ).toString("base64url");
    const tamperedToken = `${header}.${tamperedPayload}.${sig}`;

    expect(decodeAndVerifyJwt(tamperedToken)).toBeNull();
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: tamperedToken, expires_at: futureExp } },
    });
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const { proxy } = await import("../proxy");
    await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("calls getUser when alg is none (adversarial alg none attack)", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const noneToken = makeTestJwt(
      { sub: TEST_SUB_UUID, aud: "authenticated", exp: futureExp },
      { alg: "none", rawSignature: "" },
    );
    expect(decodeAndVerifyJwt(noneToken)).toBeNull();
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: noneToken, expires_at: futureExp } },
    });
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const { proxy } = await import("../proxy");
    await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("calls getUser when SUPABASE_JWT_SECRET is missing or empty (fail-closed rule)", async () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", "");
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const validToken = makeTestJwt({ sub: TEST_SUB_UUID, aud: "authenticated", exp: futureExp });
    expect(decodeAndVerifyJwt(validToken)).toBeNull();
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: validToken, expires_at: futureExp } },
    });
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const { proxy } = await import("../proxy");
    await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });
});

// getUser outcome contract (proxy.ts): the proxy reads neither `user` nor `error` from getUser().
// It never redirects, never sets an auth status and never throws. Pages enforce the fail-closed redirect.
describe("proxy getUser outcome is pass-through", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
  });

  afterEach(() => vi.restoreAllMocks());

  it("no user: passes the response through with no redirect, auth status or cookie write", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const { proxy } = await import("../proxy");
    const res = await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("getSession rejects: getUser is called once and response is getUser outcome", async () => {
    getSessionMock.mockRejectedValue(new Error("network blip on getSession"));
    getUserMock.mockResolvedValue({ data: { user: { id: "u-fallback" } }, error: null });
    const { proxy } = await import("../proxy");
    const res = await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getSessionMock).toHaveBeenCalledTimes(1);
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("getSession rejects outside production: warns with session refresh skipped and falls back to getUser", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getSessionMock.mockRejectedValue(new Error("network blip on getSession"));
    getUserMock.mockResolvedValue({ data: { user: { id: "u-fallback" } }, error: null });
    const { proxy } = await import("../proxy");
    const res = await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getSessionMock).toHaveBeenCalledTimes(1);
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(warn).toHaveBeenCalledWith("[proxy] session refresh skipped:", "network blip on getSession");
  });

  it("getSession rejects in production: stays silent and falls back to getUser", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getSessionMock.mockRejectedValue(new Error("network blip on getSession"));
    getUserMock.mockResolvedValue({ data: { user: { id: "u-fallback" } }, error: null });
    const { proxy } = await import("../proxy");
    const res = await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it("getUser resolves with an error: passes the response through without throwing", async () => {
    getUserMock.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthApiError", message: "invalid JWT", status: 401 },
    });
    const { proxy } = await import("../proxy");
    const res = await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each(ASYMMETRIC_ALG_FIXTURES)(
    "%s token: rejected locally, getUser called, online auth rejects: passes through with no session cookie",
    async (alg) => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const token = makeTestJwt({ sub: TEST_SUB_UUID, aud: "authenticated", exp: futureExp }, { alg });
      expect(token.split(".")[2]).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeAndVerifyJwt(token)).toBeNull();
      getSessionMock.mockResolvedValue({ data: { session: { access_token: token, expires_at: futureExp } } });
      getUserMock.mockResolvedValue({ data: { user: null }, error: { name: "AuthApiError", message: "invalid JWT", status: 401 } });
      const { proxy } = await import("../proxy");
      const res = await proxy(fakeRequest(["sb-portal-auth"]) as never);
      expect(getUserMock).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
    },
  );

  it("getUser rejects: passes the response through and warns outside production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getUserMock.mockRejectedValue(new Error("auth down"));
    const { proxy } = await import("../proxy");
    const res = await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(warn).toHaveBeenCalledWith("[proxy] session refresh skipped:", "auth down");
  });

  it("getUser rejects in production: passes the response through and stays silent", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getUserMock.mockRejectedValue(new Error("auth down"));
    const { proxy } = await import("../proxy");
    const res = await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(res.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it("enforces HttpOnly, Secure, and SameSite attributes on refreshed cookies", async () => {
    vi.stubEnv("NODE_ENV", "production");
    createServerClientMock.mockImplementationOnce((_url, _key, options: unknown) => ({
      auth: {
        getSession: getSessionMock,
        getUser: vi.fn(async () => {
          const opts = options as {
            cookies: {
              setAll: (
                cookiesToSet: Array<{
                  name: string;
                  value: string;
                  options?: Record<string, unknown>;
                }>,
              ) => void;
            };
          };
          opts.cookies.setAll([
            { name: "sb-portal-auth", value: "refreshed-token", options: { path: "/" } },
          ]);
          return { data: { user: { id: "u1" } }, error: null };
        }),
      },
    }));

    const { proxy } = await import("../proxy");
    const response = await proxy(fakeRequest(["sb-portal-auth"]) as never);

    const cookie = response.cookies.get("sb-portal-auth");
    expect(cookie).toBeDefined();
    expect(cookie?.value).toBe("refreshed-token");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("preserves chunked-cookie name pattern (.0, .1) when setAll writes chunked session tokens", async () => {
    createServerClientMock.mockImplementationOnce((_url, _key, options: unknown) => ({
      auth: {
        getSession: getSessionMock,
        getUser: vi.fn(async () => {
          const opts = options as {
            cookies: {
              setAll: (
                cookiesToSet: Array<{
                  name: string;
                  value: string;
                  options?: Record<string, unknown>;
                }>,
              ) => void;
            };
          };
          opts.cookies.setAll([
            { name: "sb-portal-auth.0", value: "chunk0-data", options: { path: "/" } },
            { name: "sb-portal-auth.1", value: "chunk1-data", options: { path: "/" } },
          ]);
          return { data: { user: { id: "u1" } }, error: null };
        }),
      },
    }));

    const { proxy } = await import("../proxy");
    const response = await proxy(fakeRequest(["sb-portal-auth"]) as never);

    expect(cookiesSetSpy).toHaveBeenCalledWith("sb-portal-auth.0", "chunk0-data");
    expect(cookiesSetSpy).toHaveBeenCalledWith("sb-portal-auth.1", "chunk1-data");

    const chunk0 = response.cookies.get("sb-portal-auth.0");
    const chunk1 = response.cookies.get("sb-portal-auth.1");
    expect(chunk0).toBeDefined();
    expect(chunk0?.value).toBe("chunk0-data");
    expect(chunk1).toBeDefined();
    expect(chunk1?.value).toBe("chunk1-data");

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("sb-portal-auth.0=chunk0-data");
    expect(setCookie).toContain("sb-portal-auth.1=chunk1-data");
    expect(response.cookies.get("sb-portal-auth")).toBeUndefined();
  });

  it("passes incoming chunked cookies (.0, .1) through getAll for client reassembly", async () => {
    let capturedCookies: Array<{ name: string; value: string }> = [];
    createServerClientMock.mockImplementationOnce((_url, _key, options: unknown) => {
      const opts = options as { cookies: { getAll: () => Array<{ name: string; value: string }> } };
      capturedCookies = opts.cookies.getAll();
      return {
        auth: {
          getSession: getSessionMock,
          getUser: getUserMock.mockResolvedValue({ data: { user: null }, error: null }),
        },
      };
    });

    const chunkRequest = {
      cookies: {
        getAll: () => [
          { name: "sb-portal-auth.0", value: "token-part-1." },
          { name: "sb-portal-auth.1", value: "token-part-2" },
        ],
        set: cookiesSetSpy,
      },
      url: "http://localhost:3000/creator/dashboard",
      headers: new Headers(),
    };

    const { proxy } = await import("../proxy");
    await proxy(chunkRequest as never);

    expect(capturedCookies).toEqual([
      { name: "sb-portal-auth.0", value: "token-part-1." },
      { name: "sb-portal-auth.1", value: "token-part-2" },
    ]);

    const reassembled = capturedCookies
      .filter((c) => c.name.startsWith("sb-portal-auth."))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((c) => c.value)
      .join("");
    expect(reassembled).toBe("token-part-1.token-part-2");
  });

  it("reassembles chunked cookies (.0, .1) into the expected token using real @supabase/ssr createServerClient", async () => {
    const { createServerClient: realCreateServerClient } =
      await vi.importActual<typeof import("@supabase/ssr")>("@supabase/ssr");

    const expectedToken = "token-part-1.token-part-2";
    const sessionPayload = JSON.stringify({
      access_token: expectedToken,
      refresh_token: "mock-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: TEST_SUB_UUID, aud: "authenticated" },
    });

    const cookieSlices = [
      { name: "sb-portal-auth.0", value: sessionPayload.slice(0, 40) },
      { name: "sb-portal-auth.1", value: sessionPayload.slice(40) },
    ];

    const client = realCreateServerClient("https://example.supabase.co", "test-key", {
      cookieOptions: { name: "sb-portal-auth" },
      cookies: {
        getAll: () => cookieSlices,
        setAll: () => {},
      },
    });

    const { data } = await client.auth.getSession();
    expect(data.session?.access_token).toBe(expectedToken);

    const rawStorageItem = await (
      client.auth as unknown as { storage: { getItem: (k: string) => Promise<string | null> } }
    ).storage.getItem("sb-portal-auth");
    expect(rawStorageItem).toBe(sessionPayload);
  });

  it("records mock setAll calls and asserts HttpOnly, Secure, and SameSite on each set call in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getUserMock.mockImplementation(async () => {
      lastCapturedOptions?.cookies?.setAll([
        {
          name: "sb-portal-auth",
          value: "new-token",
          options: { httpOnly: false, secure: false, sameSite: "none", path: "/" },
        },
        {
          name: "sb-portal-refresh",
          value: "new-refresh",
          options: { httpOnly: false, secure: false, sameSite: "none", path: "/" },
        },
      ]);
      return { data: { user: { id: "u-prod" } }, error: null };
    });

    const { proxy } = await import("../proxy");
    const response = await proxy(fakeRequest(["sb-portal-auth"]) as never);

    expect(recordedSetAllCalls).toHaveLength(1);
    expect(recordedSetAllCalls[0]).toHaveLength(2);
    expect(recordedSetAllCalls[0][0].name).toBe("sb-portal-auth");
    expect(recordedSetAllCalls[0][1].name).toBe("sb-portal-refresh");

    const authCookie = response.cookies.get("sb-portal-auth");
    expect(authCookie?.httpOnly).toBe(true);
    expect(authCookie?.secure).toBe(true);
    expect(authCookie?.sameSite).toBe("lax");

    const refreshCookie = response.cookies.get("sb-portal-refresh");
    expect(refreshCookie?.httpOnly).toBe(true);
    expect(refreshCookie?.secure).toBe(true);
    expect(refreshCookie?.sameSite).toBe("lax");

    const setCookieHeader = response.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain("HttpOnly");
    expect(setCookieHeader).toContain("Secure");
    expect(setCookieHeader).toContain("SameSite=lax");
  });

  it("records mock setAll calls and asserts HttpOnly, SameSite, and non-secure on each set call outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    getUserMock.mockImplementation(async () => {
      lastCapturedOptions?.cookies?.setAll([
        {
          name: "sb-portal-auth",
          value: "test-token",
          options: { httpOnly: false, secure: true, sameSite: "strict", path: "/" },
        },
      ]);
      return { data: { user: { id: "u-test" } }, error: null };
    });

    const { proxy } = await import("../proxy");
    const response = await proxy(fakeRequest(["sb-portal-auth"]) as never);

    expect(recordedSetAllCalls).toHaveLength(1);
    const authCookie = response.cookies.get("sb-portal-auth");
    expect(authCookie?.httpOnly).toBe(true);
    expect(authCookie?.secure).toBe(false);
    expect(authCookie?.sameSite).toBe("lax");
  });
});

// Host boundary (ADR 0061): pay.expanpress.com serves checkout only; expanpress.com sends checkout paths to pay.
describe("proxy host boundary (ADR 0061)", () => {
  function hostRequest(url: string): unknown {
    return { cookies: { getAll: () => [], set: cookiesSetSpy }, url, headers: new Headers() };
  }

  beforeEach(() => {
    getUserMock.mockReset();
    createServerClientMock.mockClear();
  });

  it("pay host serves checkout pages and legal pages without a session refresh", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(hostRequest("https://pay.expanpress.com/checkout/57596c19-c550-4bde-b17a-e87b86d005c5") as never);
    expect(res.headers.get("location")).toBeNull();
    const legal = await proxy(hostRequest("https://pay.expanpress.com/terms.html") as never);
    expect(legal.headers.get("location")).toBeNull();
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("pay host rewrites robots.txt to the disallow-all file", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(hostRequest("https://pay.expanpress.com/robots.txt") as never);
    expect(res.headers.get("x-middleware-rewrite")).toContain("/robots-pay.txt");
  });

  it("pay host returns 404 with no location for paths outside checkout and legal pages", async () => {
    const { proxy } = await import("../proxy");
    for (const p of ["/", "/books/retirearly500k/500k-playbook", "/creator/dashboard", "/checkoutevil", "//evil.example/x"]) {
      const res = await proxy(hostRequest(`https://pay.expanpress.com${p}`) as never);
      expect(res.status, p).toBe(404);
      expect(res.headers.get("location"), p).toBeNull();
    }
  });

  it("main host sends checkout and checkout API paths to pay with 307", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(hostRequest("https://expanpress.com/api/billing/checkout?product=abc") as never);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://pay.expanpress.com/api/billing/checkout?product=abc");
  });

  it("redirects main host /checkout/ paths to pay origin with 307 (ADR 0061)", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(hostRequest("https://expanpress.com/checkout/57596c19-c550-4bde-b17a-e87b86d005c5?coupon=early") as never);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://pay.expanpress.com/checkout/57596c19-c550-4bde-b17a-e87b86d005c5?coupon=early");
  });
});

describe("proxy host boundary: no open redirect", () => {
  it("a protocol-relative path on the pay host is a 404, never a redirect", async () => {
    const { proxy } = await import("../proxy");
    const req = { cookies: { getAll: () => [], set: cookiesSetSpy }, url: "https://pay.expanpress.com//evil.example/x", headers: new Headers() };
    const res = await proxy(req as never);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxy pay-host allowlist is path-bounded", () => {
  it("does not let a sibling of /api/billing/checkout through on the pay host", async () => {
    const { proxy } = await import("../proxy");
    const req = { cookies: { getAll: () => [], set: cookiesSetSpy }, url: "https://pay.expanpress.com/api/billing/checkoutevil", headers: new Headers() };
    const res = await proxy(req as never);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxy checkout API forwarding is symmetric (Cubic P2, 2026-10-15)", () => {
  const mk = (url: string, host = "") => ({ cookies: { getAll: () => [], set: cookiesSetSpy }, url, headers: new Headers(host ? { host } : {}) });

  it("main host does not forward a sibling of /api/billing/checkout", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(mk("https://expanpress.com/api/billing/checkoutevil") as never);
    expect(res.headers.get("location")).toBeNull();
  });

  it("main host forwards the exact route and its sub-paths to pay", async () => {
    const { proxy } = await import("../proxy");
    for (const p of ["/api/billing/checkout", "/api/billing/checkout/x"]) {
      const res = await proxy(mk(`https://expanpress.com${p}?product=a`) as never);
      expect(res.status, p).toBe(307);
      expect(res.headers.get("location"), p).toBe(`https://pay.expanpress.com${p}?product=a`);
    }
  });

  it("a forwarded request is accepted on pay and does not bounce back (no loop)", async () => {
    const { proxy } = await import("../proxy");
    for (const p of ["/api/billing/checkout", "/api/billing/checkout/x"]) {
      const forwarded = await proxy(mk(`https://expanpress.com${p}`) as never);
      const landed = forwarded.headers.get("location") as string;
      const onPay = await proxy(mk(landed) as never);
      expect(onPay.headers.get("location"), p).toBeNull();
    }
  });
});

describe("proxy E2E host probe is test-only", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers with the hostname only when the flag is set outside production", async () => {
    const { proxy } = await import("../proxy");
    vi.stubEnv("E2E_PROXY_HOST_DIAGNOSTIC", "1");
    const req = { cookies: { getAll: () => [], set: cookiesSetSpy }, url: "https://pay.expanpress.com/__e2e/proxy-host", headers: new Headers({ host: "expanpress.com" }) };
    const res = await proxy(req as never);
    expect(await res.json()).toEqual({ requestUrlHostname: "pay.expanpress.com", hostHeader: "expanpress.com" });
  });

  it("is inert without the flag", async () => {
    const { proxy } = await import("../proxy");
    vi.stubEnv("E2E_PROXY_HOST_DIAGNOSTIC", "");
    const req = { cookies: { getAll: () => [], set: cookiesSetSpy }, url: "https://expanpress.com/__e2e/proxy-host", headers: new Headers() };
    const res = await proxy(req as never);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });
});
