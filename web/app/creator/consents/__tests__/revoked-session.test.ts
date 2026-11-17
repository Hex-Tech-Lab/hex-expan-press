// Argon F-08: a consent-signing Server Action must refuse a session the auth server rejects,
// even when its JWT is still locally valid. The real supabase-server runs; only the network
// clients, cookies and Next request APIs are stubbed. The positive control proves the same
// harness signs when the auth server accepts the session.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTestJwt, MOCK_HMAC_KEY } from "../../../../src/lib/__tests__/jwt-fixtures";

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [{ name: "sb-portal-auth", value: "cookie" }],
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Map([["user-agent", "vitest-agent/1.0"]]) as unknown as Headers,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getSession: h.getSession } }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: h.getUser },
    rpc: h.rpc,
    from: () => ({
      select: () => ({
        order: () => ({
          order: () => ({ limit: async () => ({ data: [{ id: "p1", release_sha256: null }], error: null }) }),
        }),
      }),
    }),
  }),
}));

import { signConsentAction } from "../actions";

function fd(): FormData {
  const f = new FormData();
  f.set("kind", "C1_data_accuracy");
  f.set("typedName", "Jane Example");
  return f;
}

const SESSION_USER = "57596c19-c550-4bde-b17a-e87b86d005c5";

function sessionWithLocallyValidToken(): void {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const access_token = makeTestJwt({ sub: SESSION_USER, aud: "authenticated", exp, email: "a@b.c" });
  h.getSession.mockResolvedValue({ data: { session: { access_token, expires_at: exp } } });
}

describe("signConsentAction with a revoked session (Argon F-08)", () => {
  beforeEach(() => {
    h.getUser.mockReset();
    h.getSession.mockReset();
    h.rpc.mockReset();
    h.rpc.mockResolvedValue({ error: null });
    vi.stubEnv("SUPABASE_JWT_SECRET", MOCK_HMAC_KEY);
    vi.stubEnv("NODE_ENV", "test");
  });

  it("redirects to signin and writes nothing when the auth server rejects the session", async () => {
    sessionWithLocallyValidToken();
    h.getUser.mockResolvedValue({ data: { user: null }, error: { message: "invalid JWT: session revoked" } });
    await expect(signConsentAction({}, fd())).rejects.toThrow("NEXT_REDIRECT:/creator/signin");
    expect(h.getUser).toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("positive control: signs when the auth server confirms the session", async () => {
    sessionWithLocallyValidToken();
    h.getUser.mockResolvedValue({ data: { user: { id: SESSION_USER, email: "a@b.c", app_metadata: {} } }, error: null });
    const res = await signConsentAction({}, fd());
    expect(res).toEqual({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith("submit_consent", expect.objectContaining({ p_kind: "C1_data_accuracy" }));
  });
});
