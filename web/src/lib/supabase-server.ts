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

import { decodeAndVerifyJwt } from "./jwt-verify";
export { decodeAndVerifyJwt };

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

interface ReadPortalSession extends PortalSession {
  accessToken: string;
}

function safeErrorName(err: unknown): string {
  if (err instanceof Error && err.name) return err.name.replace(/[\r\n]+/g, " ").trim() || "Error";
  if (err !== null && typeof err === "object" && "name" in err && typeof (err as { name?: unknown }).name === "string") {
    const name = (err as { name: string }).name.replace(/[\r\n]+/g, " ").trim();
    if (name) return name;
  }
  return "UnknownError";
}

/**
 * Read the ssr cookie session. The user is hydrated from the local JWT when it is
 * valid for more than 60s (no network); otherwise validated online. NOT revocation-
 * safe: a session revoked server-side stays readable until its token expires.
 */
async function readPortalSession(): Promise<ReadPortalSession | null> {
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
      if (user) return { user, supabase: clientWithJwt(session.access_token), accessToken: session.access_token };
    }
  } catch (err) {
    // Malformed/chunked ssr cookies — fail closed (null). Log error name only (never tokens/cookies/message).
    console.error(`[supabase-server] ssr session read failed: ${safeErrorName(err)}`);
  }

  return null;
}

/**
 * Read-only portal session (dashboard, review and consent pages). Local JWT
 * hydration is allowed here; see getVerifiedPortalSession for anything that writes
 * or grants access. Returns null when unauthenticated — callers redirect to /creator/signin.
 */
export async function getPortalSession(): Promise<PortalSession | null> {
  const session = await readPortalSession();
  return session ? { user: session.user, supabase: session.supabase } : null;
}

/**
 * Revocation-safe portal session for mutations (consent signing, review answers)
 * and admin access. The session is verified against the auth server on every
 * call (auth.getUser with the explicit access token), so a session revoked
 * server-side is refused immediately instead of for up to the JWT lifetime.
 * Returns null when the cookie is absent, malformed, or rejected by the auth server.
 */
export async function getVerifiedPortalSession(): Promise<PortalSession | null> {
  const session = await readPortalSession();
  if (!session) return null;
  const user = await validateJwt(session.accessToken);
  if (!user) return null;
  return { user, supabase: session.supabase };
}

/** Sign-out: clear every portal auth cookie (Server Action context). */
export async function clearPortalCookies(): Promise<void> {
  const cookieStore = await cookies();
  for (const name of cookieStore.getAll().map((c) => c.name)) {
    if (name.startsWith(SSR_COOKIE)) cookieStore.delete(name);
  }
}
