// @vitest-environment jsdom
// Component test for the AuthBridge (qa-intel: auth-bearing file needs a
// sibling regression test). Covers: cookie establishment + refresh on first
// session, fail-closed behavior without a session, and hash stripping.
// Rendered via createElement (plain .ts, per the qa-intel scanner contract).
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getUserMock = vi.fn();
const getSessionMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: getUserMock, getSession: getSessionMock } }),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-key";

let client: Root | null = null;
let host: HTMLElement | null = null;

async function renderBridge(mustHaveSession = false): Promise<void> {
  const { default: AuthBridge } = await import("../auth-bridge");
  host = document.createElement("div");
  document.body.appendChild(host);
  client = createRoot(host);
  client.render(createElement(AuthBridge, { mustHaveSession }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AuthBridge (component)", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    getSessionMock.mockReset();
    refreshMock.mockReset();
    document.cookie = "sb_session=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    window.location.hash = "";
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    client?.unmount();
    host?.remove();
    client = null;
    host = null;
    vi.unstubAllEnvs();
  });

  it("writes the session cookie and refreshes the route on first session", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt-token", expires_in: 3600 } } });
    await renderBridge();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.cookie).toContain("sb_session=jwt-token");
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("stays fail-closed without a session: no cookie written, no refresh", async () => {
    // The redirect decision itself is unit-tested in auth-bridge-core;
    // here we assert the observable fail-closed contract of the component.
    getUserMock.mockResolvedValue({ data: { user: null }, error: { message: "no session" } });
    await renderBridge(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.cookie).not.toContain("sb_session=");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("strips the OAuth hash and does not double-refresh when a cookie existed", async () => {
    document.cookie = "sb_session=existing; path=/";
    window.location.hash = "#access_token=abc";
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "jwt-new", expires_in: 3600 } } });
    await renderBridge();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(window.location.hash).toBe("");
    expect(refreshMock).not.toHaveBeenCalled();
    expect(document.cookie).toContain("sb_session=jwt-new");
  });
});
