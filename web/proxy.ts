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
/**
 * Host boundary (ADR 0061). pay.expanpress.com is the only checkout origin: it
 * serves checkout pages, the checkout API, the legal pages and its own robots
 * file, and nothing else. expanpress.com sends checkout paths to pay.
 */
const PAY_HOST = "pay.expanpress.com";
const MAIN_HOST = "expanpress.com";
const PAY_ORIGIN = "https://pay.expanpress.com";
const MAIN_ORIGIN = "https://expanpress.com";
const PAY_ALLOWED_PREFIXES = ["/checkout/", "/api/billing/checkout/", "/_next/", "/assets/"];
const PAY_ALLOWED_EXACT_API = ["/api/billing/checkout"];
const PAY_ALLOWED_EXACT = ["/terms.html", "/privacy.html", "/refund-policy.html", "/legal/providers.html", "/favicon.ico"];

// The checkout API, bounded to the exact route or its sub-paths. Used on BOTH hosts so a main-host
// forward and the pay-host allowlist agree: a looser main-host match (startsWith) forwarded
// /api/billing/checkoutevil to pay, which bounced it back to main in a loop (Cubic P2, 2026-10-15).
const isPayCheckoutApi = (path: string): boolean => PAY_ALLOWED_EXACT_API.includes(path) || path.startsWith("/api/billing/checkout/");

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  // Test-only probe for the cross-origin E2E: reports the hostname the proxy sees. Off in production builds
  // and unless the flag is explicitly set.
  if (process.env.NODE_ENV !== "production" && process.env.E2E_PROXY_HOST_DIAGNOSTIC === "1" && path === "/__e2e/proxy-host") {
    return NextResponse.json({ requestUrlHostname: url.hostname, hostHeader: request.headers.get("host") });
  }
  if (host === PAY_HOST) {
    if (path === "/robots.txt") return NextResponse.rewrite(new URL("/robots-pay.txt", request.url));
    const allowed = PAY_ALLOWED_EXACT.includes(path) || isPayCheckoutApi(path) || PAY_ALLOWED_PREFIXES.some((p) => path.startsWith(p));
    // Collapse leading slashes so "//host/..." cannot become a protocol-relative redirect (open redirect).
    if (!allowed) return NextResponse.redirect(new URL("/" + path.replace(/^\/+/, "") + url.search, MAIN_ORIGIN), 302);
    return NextResponse.next({ request });
  }
  if (host === MAIN_HOST && (path.startsWith("/checkout/") || isPayCheckoutApi(path))) {
    return NextResponse.redirect(new URL(path + url.search, PAY_ORIGIN), 307);
  }
  // Session refresh is needed only on creator-portal routes and the auth callback.
  if (!(path.startsWith("/creator") || path === "/auth/callback")) return NextResponse.next({ request });

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
  // Every page request, so the host boundary applies. Static build assets are skipped.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
