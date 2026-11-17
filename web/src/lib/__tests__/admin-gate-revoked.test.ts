// Argon F-08: the admin gate must refuse a session the auth server rejects, even when the
// token is still locally valid. Uses the real supabase-server (only the network clients and the
// cookie store are stubbed), so the refusal comes from getVerifiedPortalSession itself.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTestJwt, MOCK_HMAC_KEY } from "./jwt-fixtures";

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
  ADMIN_ID: "00000000-0000-0000-0000-0000000000ad",
}));
const { ADMIN_ID } = h;
const TOKEN_SUB = ADMIN_ID;

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [{ name: "sb-portal-auth", value: "cookie" }],
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Map<string, string>(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getSession: h.getSession } }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: h.getUser }, from: () => ({}) }),
}));

vi.mock("../../../../payments/src/settings_registry", () => ({
  GLOBAL: { admin: { admin_user_ids: [h.ADMIN_ID], audit_log_page_size: 50 } },
  jwtSkewRetryDelayMs: () => 350,
}));

import { resolveAdminAccess } from "../admin";

function sessionWithLocallyValidToken(): void {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const access_token = makeTestJwt({ sub: TOKEN_SUB, aud: "authenticated", exp, email: "admin@expanpress.com" });
  h.getSession.mockResolvedValue({ data: { session: { access_token, expires_at: exp } } });
}

describe("resolveAdminAccess (Argon F-08 revocation-safe admin gate)", () => {
  beforeEach(() => {
    h.getUser.mockReset();
    h.getSession.mockReset();
    vi.stubEnv("SUPABASE_JWT_SECRET", MOCK_HMAC_KEY);
    vi.stubEnv("NODE_ENV", "test");
  });

  it("refuses an allowlisted admin whose session the auth server rejects", async () => {
    sessionWithLocallyValidToken();
    h.getUser.mockResolvedValue({ data: { user: null }, error: { message: "invalid JWT: session revoked" } });
    expect(await resolveAdminAccess()).toEqual({ status: "unauthenticated" });
    expect(h.getUser).toHaveBeenCalled();
  });

  it("grants access to the allowlisted admin when the auth server confirms the session", async () => {
    sessionWithLocallyValidToken();
    h.getUser.mockResolvedValue({ data: { user: { id: ADMIN_ID } }, error: null });
    expect(await resolveAdminAccess()).toEqual({ status: "ok", userId: ADMIN_ID });
  });

  it("returns forbidden for a verified non-admin", async () => {
    sessionWithLocallyValidToken();
    h.getUser.mockResolvedValue({ data: { user: { id: "someone-else" } }, error: null });
    expect(await resolveAdminAccess()).toEqual({ status: "forbidden" });
  });
});
