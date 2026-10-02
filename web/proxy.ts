import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Session-refresh boundary (Wave 5.1, P1): the ONLY place in Next.js where a
 * Supabase token refresh can safely append Set-Cookie headers to a response.
 * Server Components cannot mutate cookies (next/headers set() is ignored
 * during RSC render), so the refresh must happen here.
 *
 * Runs getUser() (network validation — never trust getSession locally) on
 * creator-portal routes; pages still enforce their own redirects, this
 * proxy only guarantees fresh cookies ride the response.
 *
 * Cookie options are EXPLICIT — the @supabase/ssr default is httpOnly:false
 * (verified v0.12.7 constants.js), which would defeat the Wave 5 objective.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  // Attributes forced onto every Set-Cookie. The storage-key `name` is kept
  // separate: spreading it into cookies.set() would rename Supabase's chunked
  // (`.0`, `.1`) and PKCE cookies onto one key (audit F1, 2026-10-02).
  const cookieAttributes = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
  };
  const cookieOptions = { name: "sb-portal-auth", ...cookieAttributes };

  try {
    // Construction INSIDE the failure boundary (P0 2026-09-29): an env gap
    // must degrade to "no cookie refresh", never crash the proxy — an
    // uncaught throw here turns every matched route into a 500
    // MIDDLEWARE_INVOCATION_FAILED, taking the auth surface down harder
    // than any misconfiguration justifies. Pages enforce their own
    // fail-closed redirects; the proxy only guarantees fresh cookies.
    const supabase = createServerClient(
      process.env.SUPABASE_URL ?? "",
      process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
      {
        cookieOptions,
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            for (const { name, value } of cookiesToSet) {
              request.cookies.set(name, value);
            }
            // Re-create the response so the proxy chain sees the updated
            // request cookies, then mirror them onto the outgoing response.
            response = NextResponse.next({ request });
            for (const { name, value, options } of cookiesToSet) {
              response.cookies.set(name, value, { ...options, ...cookieAttributes });
            }
          },
        },
      },
    );

    await supabase.auth.getUser();
  } catch (err) {
    // Missing env or network/auth-service failure must not take pages down —
    // pages enforce their own fail-closed redirects; the response carries on.
    if (process.env.NODE_ENV !== "production") {
      console.warn("[proxy] session refresh skipped:", err instanceof Error ? err.message : err);
    }
  }

  return response;
}

export const config = {
  matcher: ["/creator/:path*", "/auth/callback"],
};
