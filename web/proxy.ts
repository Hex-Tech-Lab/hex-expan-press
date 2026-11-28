import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { GLOBAL } from "../payments/src/settings_registry";
import { acceptsHtml, renderBrandedB2cHtml } from "./src/lib/branded-html";
import { COUNTRY_RESTRICTION_MESSAGE } from "./src/lib/sales-scope";

/**
 * Session-refresh boundary (Wave 5.1, P1): the ONLY place in Next.js where a
 * Supabase token refresh can safely append Set-Cookie headers to a response.
 * Server Components cannot mutate cookies (next/headers set() is ignored
 * during RSC render), so the refresh must happen here.
 *
 * Verifies the session JWT locally via HMAC-SHA256 (skipping getUser network
 * egress when valid with >60s remaining); falls back to network validation via
 * getUser() on expiry, tampering, or missing secret. Pages still enforce their
 * own redirects; this proxy guarantees fresh cookies ride the response.
 *
 * Cookie options are EXPLICIT — the @supabase/ssr default is httpOnly:false
 * (verified v0.12.7 constants.js), which would defeat the Wave 5 objective.
 */
/**
 * Host boundary (ADR 0061). pay.expanpress.com is the only checkout origin: it
 * serves checkout pages, the checkout API, the legal pages and its own robots
 * file, and nothing else. expanpress.com sends checkout paths to pay.
 */
// The pay origin comes from the settings registry (ADR 0061), so the host guard and the redirect target cannot drift apart.
const PAY_ORIGIN = GLOBAL.storefront.pay_origin;
const PAY_HOST = new URL(PAY_ORIGIN).host;
// Apex and www hosts come from the registry (site.root_host, site.www_host). www is the B2B host (founder, 2026-11-15).
// It must not serve checkout either: ADR 0061 makes pay the only checkout origin.
const MAIN_HOST = GLOBAL.site.root_host;
const WWW_HOST = GLOBAL.site.www_host;
const PAY_ALLOWED_PREFIXES = ["/checkout/", "/api/billing/checkout/", "/_next/", "/assets/"];
const PAY_ALLOWED_EXACT_API = ["/api/billing/checkout"];
// Buyer legal set only (B2C). The creator (B2B) set at /terms.html, /privacy.html, /refund-policy.html and
// /legal/providers.html governs the creator relationship and is NOT served on pay.
const PAY_ALLOWED_EXACT = [
  "/books/legal/terms.html",
  "/books/legal/privacy.html",
  "/books/legal/refund-policy.html",
  "/books/legal/providers.html",
  "/favicon.ico",
];
const NOINDEX_LEGAL_PATHS = ["/books/legal/providers.html", "/legal/providers.html"];

function applyNoindexHeader(response: NextResponse, path: string): NextResponse {
  if (NOINDEX_LEGAL_PATHS.includes(path)) {
    response.headers.set("x-robots-tag", "noindex, nofollow");
  }
  return response;
}

// The checkout API, bounded to the exact route or its sub-paths. Used on BOTH hosts so a main-host
// forward and the pay-host allowlist agree: a looser main-host match (startsWith) forwarded
// /api/billing/checkoutevil to pay, which bounced it back to main in a loop (Cubic P2, 2026-10-15).
const isPayCheckoutApi = (path: string): boolean => PAY_ALLOWED_EXACT_API.includes(path) || path.startsWith("/api/billing/checkout/");

function buyerCountryBlocked(request: NextRequest, path: string): NextResponse | null {
  if (!path.startsWith("/checkout/") && !isPayCheckoutApi(path)) return null;
  const ipCountry = request.headers.get("x-vercel-ip-country")?.trim().toUpperCase();
  if (!ipCountry || GLOBAL.payments.allowed_buyer_countries.includes(ipCountry)) return null;
  // 403 Forbidden: HEAD stays bodyless, API stays JSON, browser HTML requests get the branded 403 Forbidden page.
  if (request.method === "HEAD") return new NextResponse(null, { status: 403 });
  const msg = COUNTRY_RESTRICTION_MESSAGE;
  if (isPayCheckoutApi(path)) {
    return NextResponse.json({ ok: false, error: msg, code: "country_not_supported" }, { status: 403 });
  }
  if (acceptsHtml(request.headers)) {
    const html = renderBrandedB2cHtml({
      title: "403 Forbidden · US-only checkout",
      kicker: "403 Forbidden · Region restriction",
      heading: "Checkout is currently US-only",
      body: msg,
      includeSupportLink: true,
    });
    return new NextResponse(html, {
      status: 403,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }
  return new NextResponse(msg, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Small 200 OK landing page for bare pay.expanpress.com/ (LV-05). Stays strictly on-brand and B2C-confined:
 *  uses the storefront {expanpress} wordmark, tokens, type and card styles; links only to the registry B2C
 *  catalog and the buyer legal set on pay, never to creator/B2B pages. */
function payRootHtml(): string {
  return renderBrandedB2cHtml({
    title: GLOBAL.storefront.pay_root_heading,
    kicker: GLOBAL.storefront.pay_root_kicker,
    heading: GLOBAL.storefront.pay_root_heading,
    body: GLOBAL.storefront.pay_root_description,
  });
}

import { decodeAndVerifyJwt } from "./src/lib/jwt-verify";
export { decodeAndVerifyJwt };

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  let host = url.hostname.toLowerCase();
  // Local E2E only: next dev sets request.url to localhost regardless of Host header. Never active in production.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.E2E_PROXY_HOST_OVERRIDE === "1" &&
    (host === "localhost" || host === "127.0.0.1")
  ) {
    const hdrHost = request.headers.get("host")?.split(":")[0]?.trim().toLowerCase();
    if (hdrHost === PAY_HOST) host = PAY_HOST;
  }
  const path = url.pathname;
  // Test-only probe for the cross-origin E2E: reports the hostname the proxy sees. Off in production builds
  // and unless the flag is explicitly set.
  if (process.env.NODE_ENV !== "production" && process.env.E2E_PROXY_HOST_DIAGNOSTIC === "1" && path === "/__e2e/proxy-host") {
    return NextResponse.json({ requestUrlHostname: url.hostname, hostHeader: request.headers.get("host") });
  }
  if (host === PAY_HOST) {
    if (path === "/robots.txt") return NextResponse.rewrite(new URL("/robots-pay.txt", request.url));
    if (path === "/" || path === "") {
      const headers = {
        "content-type": "text/html; charset=utf-8",
        "x-robots-tag": "noindex, nofollow",
        "cache-control": `public, max-age=${GLOBAL.limits.pay_root_max_age_seconds}`,
      };
      return new NextResponse(request.method === "HEAD" ? null : payRootHtml(), { status: 200, headers });
    }
    const allowed = PAY_ALLOWED_EXACT.includes(path) || isPayCheckoutApi(path) || PAY_ALLOWED_PREFIXES.some((p) => path.startsWith(p));
    // Pay serves /, checkout, legal pages and their assets only. Everything else is a hard 404: no redirect
    // to the main site, so a pay URL never bounces to the apex or www.
    if (!allowed) return new NextResponse(null, { status: 404 });
    const blocked = buyerCountryBlocked(request, path);
    if (blocked) return blocked;
    return applyNoindexHeader(NextResponse.next({ request }), path);
  }
  const blocked = buyerCountryBlocked(request, path);
  if (blocked) return blocked;
  if ((host === MAIN_HOST || host === WWW_HOST) && (path.startsWith("/checkout/") || isPayCheckoutApi(path))) {
    return NextResponse.redirect(new URL(path + url.search, PAY_ORIGIN), 307);
  }
  // Session refresh is needed only on creator-portal routes and the auth callback.
  if (!(path.startsWith("/creator") || path === "/auth/callback")) {
    return applyNoindexHeader(NextResponse.next({ request }), path);
  }

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

    // Egress optimization: Check session token locally first.
    // If token is valid, has valid sub UUID, aud === "authenticated", and >60s remaining
    // before expiry, skip getUser() to avoid blocking HTTP round-trips to Supabase Auth.
    // If expired, near expiry (<= 60s), invalid, or getSession is unavailable/fails,
    // getUser() triggers @supabase/ssr session refresh and writes chunked cookies.
    let needsRefresh = true;
    if (typeof supabase.auth.getSession === "function") {
      try {
        const { data } = await supabase.auth.getSession();
        const session = data?.session;
        if (session?.access_token) {
          const claims = decodeAndVerifyJwt(session.access_token);
          if (claims) {
            needsRefresh = false;
          }
        }
      } catch (err) {
        // If getSession throws or fails, proceed to getUser fallback
        if (process.env.NODE_ENV !== "production") {
          console.warn("[proxy] session refresh skipped:", err instanceof Error ? err.message : err);
        }
      }
    }

    if (needsRefresh) {
      await supabase.auth.getUser();
    }
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
