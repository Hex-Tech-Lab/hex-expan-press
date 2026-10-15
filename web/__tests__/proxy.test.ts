// Proxy contract tests (qa-intel security rule: the getUser session
// boundary needs a sibling regression test).
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserMock = vi.fn();
const createServerClientMock = vi.fn(() => ({ auth: { getUser: getUserMock } }));
const cookiesSetSpy = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => createServerClientMock(...(args as [])),
}));

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
    createServerClientMock.mockClear();
    cookiesSetSpy.mockClear();
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-key";
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

  it("pay host sends other paths back to the main site", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(hostRequest("https://pay.expanpress.com/books/retirearly500k/500k-playbook") as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://expanpress.com/books/retirearly500k/500k-playbook");
  });

  it("main host sends checkout and checkout API paths to pay with 307", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(hostRequest("https://expanpress.com/api/billing/checkout?product=abc") as never);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://pay.expanpress.com/api/billing/checkout?product=abc");
  });
});

describe("proxy host boundary: no open redirect", () => {
  it("a protocol-relative path on the pay host stays on the main origin", async () => {
    const { proxy } = await import("../proxy");
    const req = { cookies: { getAll: () => [], set: cookiesSetSpy }, url: "https://pay.expanpress.com//evil.example/x", headers: new Headers() };
    const res = await proxy(req as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://expanpress.com/evil.example/x");
  });
});

describe("proxy pay-host allowlist is path-bounded", () => {
  it("does not let a sibling of /api/billing/checkout through on the pay host", async () => {
    const { proxy } = await import("../proxy");
    const req = { cookies: { getAll: () => [], set: cookiesSetSpy }, url: "https://pay.expanpress.com/api/billing/checkoutevil", headers: new Headers() };
    const res = await proxy(req as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://expanpress.com/api/billing/checkoutevil");
  });
});
