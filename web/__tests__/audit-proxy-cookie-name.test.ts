// AUDIT 2026-10-02 (F1): proxy re-injects cookieOptions.name into every
// Set-Cookie, so chunked/PKCE cookies all collapse onto "sb-portal-auth".
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_u: string, _k: string, opts: { cookies: { setAll: (c: unknown[]) => void } }) => ({
    auth: {
      getUser: async () => {
        // What @supabase/ssr hands setAll on a refresh of a >3.1 KB session: chunked names, options with name already deleted.
        opts.cookies.setAll([
          { name: "sb-portal-auth.0", value: "chunk0", options: { path: "/", maxAge: 100 } },
          { name: "sb-portal-auth.1", value: "chunk1", options: { path: "/", maxAge: 100 } },
        ]);
        return { data: { user: null }, error: null };
      },
    },
  }),
}));

describe("F1 proxy cookie names", () => {
  it("emits Set-Cookie under the chunk names supabase asked for", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(new NextRequest("https://x.test/creator/dashboard"));
    const names = res.cookies.getAll().map((c) => c.name).sort();
    expect(names).toEqual(["sb-portal-auth.0", "sb-portal-auth.1"]);
    const header = res.headers.getSetCookie().join("\n");
    expect(header).toMatch(/^sb-portal-auth\.0=chunk0/m);
  });
});
