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
 * middleware only guarantees fresh cookies ride the response.
 *
 * Cookie options are EXPLICIT — the @supabase/ssr default is httpOnly:false
 * (verified v0.12.7 constants.js), which would defeat the Wave 5 objective.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const cookieOptions = {
    name: "sb-portal-auth",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
  };

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
          // Re-create the response so the middleware chain sees the updated
          // request cookies, then mirror them onto the outgoing response.
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, { ...options, ...cookieOptions });
          }
        },
      },
    },
  );

  try {
    await supabase.auth.getUser();
  } catch (err) {
    // Network/auth-service failure must not take pages down — pages enforce
    // their own fail-closed redirects; the response simply carries on.
    if (process.env.NODE_ENV !== "production") {
      console.warn("[middleware] session refresh probe failed", err);
    }
  }

  return response;
}

export const config = {
  matcher: ["/creator/:path*", "/auth/callback"],
};
