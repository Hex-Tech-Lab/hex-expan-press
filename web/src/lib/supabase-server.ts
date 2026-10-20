import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import "server-only";
import { jwtSkewRetryDelayMs } from "../../../payments/src/settings_registry";
import { createSkewRetryFetch } from "./skew-retry-fetch";

/**
 * Server-side Supabase access for the creator portal (Wave 5).
 *
 * Single auth path: the @supabase/ssr HttpOnly cookie session (written by
 * the /auth/callback code exchange and the signin Server Actions). The
 * legacy `sb_session` JWT-cookie bridge was retired in Wave 5 — no
 * JS-readable token exists anymore. The access token from the ssr session
 * is validated against the auth server via getUser() (network check — never
 * trust an unverified token), and all queries run with it on the
 * Authorization header so RLS applies as the user.
 *
 * No service_role/secret key is ever used here (publishable key only).
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SSR_COOKIE = "sb-portal-auth";

export interface PortalSession {
  user: User;
  supabase: SupabaseClient; // queries run with the user's JWT — RLS enforced
}

/** Validate a JWT against the auth server. Returns the user or null. */
async function validateJwt(jwt: string): Promise<User | null> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: {
      headers: { Authorization: `Bearer ${jwt}` },
      fetch: createSkewRetryFetch(fetch, jwtSkewRetryDelayMs()),
    },
  });
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) return null;
  return data.user;
}

/** Author queries with the user's JWT on the wire — RLS decides visibility. */
function clientWithJwt(jwt: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: {
      headers: { Authorization: `Bearer ${jwt}` },
      fetch: createSkewRetryFetch(fetch, jwtSkewRetryDelayMs()),
    },
  });
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * Validates and decodes a Supabase JWT locally without network calls.
 * Ensures 3 base64url segments, valid sub UUID, aud === "authenticated",
 * and at least 60s remaining before expiry (exp > now + 60).
 */
export function decodeAndVerifyJwt(token: string): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  if (!parts[0] || !parts[1] || !parts[2]) return null;
  if (!BASE64URL_REGEX.test(parts[0]) || !BASE64URL_REGEX.test(parts[1]) || !BASE64URL_REGEX.test(parts[2])) {
    return null;
  }

  try {
    const jsonStr =
      typeof Buffer !== "undefined"
        ? Buffer.from(parts[1], "base64url").toString("utf8")
        : atob(parts[1].replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (parts[1].length % 4)) % 4));
    const payload = JSON.parse(jsonStr);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp - now <= 60) {
      return null;
    }
    if (typeof payload.sub !== "string" || !UUID_REGEX.test(payload.sub)) return null;

    const aud = payload.aud;
    const isValidAud = aud === "authenticated" || (Array.isArray(aud) && aud.includes("authenticated"));
    if (!isValidAud) return null;

    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Hydrates a User object locally from a verified JWT token.
 * Returns null if token is invalid, expired, near expiry (<= 60s), or claims are invalid.
 */
export function hydrateUserFromLocalJwt(token: string): User | null {
  const claims = decodeAndVerifyJwt(token);
  if (!claims) return null;
  return {
    id: claims.sub as string,
    email: typeof claims.email === "string" ? claims.email : "",
    app_metadata: (claims.app_metadata && typeof claims.app_metadata === "object" && !Array.isArray(claims.app_metadata) ? claims.app_metadata : {}) as Record<string, unknown>,
    user_metadata: (claims.user_metadata && typeof claims.user_metadata === "object" && !Array.isArray(claims.user_metadata) ? claims.user_metadata : {}) as Record<string, unknown>,
    aud: typeof claims.aud === "string" ? claims.aud : "authenticated",
    created_at: typeof claims.created_at === "string" ? claims.created_at : new Date().toISOString(),
  } as User;
}

/**
 * Resolve the portal session from the ssr HttpOnly cookie. Returns null when
 * unauthenticated — callers redirect to /creator/signin (server-side).
 */
export async function getPortalSession(): Promise<PortalSession | null> {
  const cookieStore = await cookies();

  const hasSsrCookie = cookieStore.getAll().some((c) => c.name.startsWith(SSR_COOKIE));
  if (!hasSsrCookie) return null;

  try {
    const ssr = createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      cookieOptions: { name: SSR_COOKIE },
      // READ-ONLY: Server Components cannot mutate cookies (next/headers
      // set() is ignored during RSC render) — session refresh happens in
      // proxy.ts, the only legal Set-Cookie boundary (Wave 5.1).
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
      },
    });
    const { data } = await ssr.auth.getSession();
    const session = data.session;
    if (session?.access_token) {
      // Egress optimization: when access token is locally valid and
      // has >60s until expiry, hydrate user locally to avoid blocking network round-trips.
      let user: User | null = hydrateUserFromLocalJwt(session.access_token);
      if (!user) {
        user = await validateJwt(session.access_token);
      }
      if (user) return { user, supabase: clientWithJwt(session.access_token) };
    }
  } catch (err) {
    // Malformed/chunked ssr cookies — fail closed (null).
    if (process.env.NODE_ENV !== "production") {
      console.warn("[supabase-server] ssr session read failed", err);
    }
  }

  return null;
}

/** Sign-out: clear every portal auth cookie (Server Action context). */
export async function clearPortalCookies(): Promise<void> {
  const cookieStore = await cookies();
  for (const name of cookieStore.getAll().map((c) => c.name)) {
    if (name.startsWith(SSR_COOKIE)) cookieStore.delete(name);
  }
}
