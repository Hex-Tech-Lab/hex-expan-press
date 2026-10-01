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
