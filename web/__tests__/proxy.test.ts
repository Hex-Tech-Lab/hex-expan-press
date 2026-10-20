// Proxy contract tests (qa-intel security rule: the getUser session
// boundary needs a sibling regression test).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decodeAndVerifyJwt } from "../src/lib/jwt-verify";
import { MOCK_HMAC_KEY, makeTestJwt } from "../src/lib/__tests__/jwt-fixtures";

const getUserMock = vi.fn();
const getSessionMock = vi.fn();
const createServerClientMock = vi.fn(() => ({
  auth: {
    getUser: getUserMock,
    getSession: getSessionMock,
  },
}));
const cookiesSetSpy = vi.fn();

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
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-key";
    process.env.SUPABASE_JWT_SECRET = MOCK_HMAC_KEY;
    process.env.NODE_ENV = "test";
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
    delete process.env.SUPABASE_JWT_SECRET;
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
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-key";
    process.env.NODE_ENV = "test";
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
    process.env.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getUserMock.mockRejectedValue(new Error("auth down"));
    const { proxy } = await import("../proxy");
    const res = await proxy(fakeRequest(["sb-portal-auth"]) as never);
    expect(res.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
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
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-key";
    process.env.SUPABASE_JWT_SECRET = MOCK_HMAC_KEY;
    process.env.NODE_ENV = "test";
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
