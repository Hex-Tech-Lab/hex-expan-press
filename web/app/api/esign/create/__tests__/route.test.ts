// Authorization + contract tests for the NATIVE esign/create route handler
// (Wave 6 — replaces the shim-bridged legacy handler).
//
// Auth is the ssr HttpOnly cookie session via getPortalSession (the ONLY
// path since Wave 5 — no Authorization-header bridge). Branches covered:
//   1. No ssr cookie → 401 BEFORE any body parsing or use-case work.
//   2. Valid session + valid body → 200 {ok, url} with the use case called
//      under the session user (RLS identity), host resolved from
//      x-forwarded-host (preview deployments).
//   3. Valid session + malformed JSON → 400.
//   4. Valid session + missing productId → 400.
//   5. Firma credits failure → 503 (never a raw 500/exception).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

const getUserMock = vi.fn();
const getSessionMock = vi.fn();
const createClientMock = vi.fn(() => ({ auth: { getUser: getUserMock } }));
const createServerClientMock = vi.fn(() => ({ auth: { getSession: getSessionMock } }));
const createEnvelopeMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: ((...args: unknown[]) => createClientMock(...(args as []))) as never,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: ((...args: unknown[]) => createServerClientMock(...(args as []))) as never,
}));

vi.mock("../../../../../../src/use_cases/create_esign_envelope", () => ({
  createEsignEnvelopeUseCase: ((...args: unknown[]) => createEnvelopeMock(...(args as []))) as never,
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

// The handler only consumes .json()/.headers at runtime — the NextRequest
// wrapper fields are unused, so plain Requests are cast for type-checking.
const asNextRequest = (req: Request): NextRequest => req as unknown as NextRequest;

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";

const CREATE_URL = "http://localhost:3000/api/esign/create";

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(CREATE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function authSession(): void {
  setCookie("sb-portal-auth", "valid-ssr-cookie");
  getSessionMock.mockResolvedValue({ data: { session: { access_token: "sample-access-value" } } });
  getUserMock.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.c" } }, error: null });
}

describe("esign/create native route (Wave 6)", () => {
  beforeEach(() => {
    cookieStore.clear();
    getUserMock.mockReset();
    getSessionMock.mockReset();
    createClientMock.mockClear();
    createServerClientMock.mockClear();
    createEnvelopeMock.mockReset();
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.NEXT_PUBLIC_SITE_ORIGIN;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 with no ssr cookie — before any body parsing or use-case work", async () => {
    const { POST } = await import("../route");
    const res = await POST(asNextRequest(post(JSON.stringify({ productId: "p1" }))));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "Unauthorized" });
    // Fail-closed: the envelope use case must never be reached unauthenticated.
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("creates an envelope for a valid session and forwards the RLS identity + host", async () => {
    authSession();
    createEnvelopeMock.mockResolvedValue({ signUrl: "https://firma.test/sign/env_1" });
    const { POST } = await import("../route");
    const res = await POST(
      asNextRequest(
        post(JSON.stringify({ productId: "prod_42" }), {
          "x-forwarded-host": "preview.example",
          "x-forwarded-proto": "https",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, url: "https://firma.test/sign/env_1" });
    expect(createEnvelopeMock).toHaveBeenCalledTimes(1);
    const [input] = createEnvelopeMock.mock.calls[0] as [
      { productId: string; userId: string; userEmail: string; hostUrl: string },
      unknown,
    ];
    expect(input.productId).toBe("prod_42");
    expect(input.userId).toBe("u1");
    expect(input.userEmail).toBe("a@b.c");
    // Canonical-origin env unset → falls back to the forwarded host header.
    expect(input.hostUrl).toBe("https://preview.example");
  });

  it("returns 400 for malformed JSON even when authenticated", async () => {
    authSession();
    const { POST } = await import("../route");
    const res = await POST(asNextRequest(post("{not-json")));
    expect(res.status).toBe(400);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the body lacks productId", async () => {
    authSession();
    const { POST } = await import("../route");
    const res = await POST(asNextRequest(post(JSON.stringify({ wrong: "shape" }))));
    expect(res.status).toBe(400);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("maps a Firma credits failure to 503 (never a raw 500)", async () => {
    authSession();
    createEnvelopeMock.mockRejectedValue(new Error("Firma: insufficient credits (402)"));
    const { POST } = await import("../route");
    const res = await POST(asNextRequest(post(JSON.stringify({ productId: "prod_42" }))));
    expect(res.status).toBe(503);
  });
});
