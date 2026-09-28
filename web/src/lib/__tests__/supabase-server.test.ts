// Authorization regression tests for web/src/lib/supabase-server.ts
// (qa-intel high-severity rule: auth-bearing changes need sibling tests).
//
// Branches covered:
//   1. No cookies at all → null (fail-closed).
//   2. ssr-format cookie present but malformed → JWT bridge fallback.
//   3. Invalid JWT cookie → getUser rejects → null (fail-closed).
//   4. Valid JWT cookie → session returned, queries run under the user's
//      Authorization header (RLS enforced), getUser called with the token.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

const getUserMock = vi.fn();
const createClientMock = vi.fn(() => ({ auth: { getUser: getUserMock } }));
const createServerClientMock = vi.fn();

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

describe("getPortalSession (authorization branches)", () => {
  beforeEach(() => {
    cookieStore.clear();
    getUserMock.mockReset();
    createClientMock.mockClear();
    createServerClientMock.mockClear();
    vi.stubEnv("NODE_ENV", "test");
  });

  it("returns null when no portal cookies exist (fail-closed)", async () => {
    const { getPortalSession } = await import("../supabase-server");
    const result = await getPortalSession();
    expect(result).toBeNull();
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("falls back to the JWT bridge when ssr cookies are malformed", async () => {
    setCookie("sb-portal-auth", "not-even-json");
    setCookie("sb_session", "bridge-jwt");
    getUserMock.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });
    const { getPortalSession } = await import("../supabase-server");
    const result = await getPortalSession();
    expect(result).not.toBeNull();
    expect(result?.user.id).toBe("u1");
    expect(result?.supabase).not.toBeNull();
  });

  it("returns null when the JWT cookie is invalid (getUser rejects)", async () => {
    setCookie("sb_session", "forged-token");
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: { message: "invalid claim" } });
    const { getPortalSession } = await import("../supabase-server");
    const result = await getPortalSession();
    expect(result).toBeNull();
    expect(getUserMock).toHaveBeenCalledWith("forged-token");
  });

  it("returns a session whose client sends the user JWT (RLS as the user)", async () => {
    setCookie("sb_session", "valid-jwt");
    getUserMock.mockResolvedValueOnce({ data: { user: { id: "u2", email: "c@example.com" } }, error: null });

    const { getPortalSession } = await import("../supabase-server");
    const result = await getPortalSession();
    expect(result?.user.email).toBe("c@example.com");
    expect(createClientMock).toHaveBeenLastCalledWith(
      "https://example.supabase.co",
      "test-publishable-key",
      expect.objectContaining({
        global: { headers: { Authorization: "Bearer valid-jwt" } },
      }),
    );
    expect(getUserMock).toHaveBeenCalledWith("valid-jwt");
  });

  it("never reaches network validation when the token cookie is absent", async () => {
    // ssr path only, no JWT cookie, ssr session unusable → still fail-closed
    (createServerClientMock as Mock).mockImplementation(() => ({
      auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
    }));
    setCookie("sb-portal-auth.0", "chunk-without-session");
    const { getPortalSession } = await import("../supabase-server");
    const result = await getPortalSession();
    expect(result).toBeNull();
  });
});
