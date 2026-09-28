import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import "server-only";

/**
 * Server-side Supabase access for the creator portal (Wave 4).
 *
 * Two auth paths, in priority order:
 *  1. @supabase/ssr cookie session — the Wave 5 target once sign-in migrates
 *     into the app and writes ssr-format cookies.
 *  2. `sb_session` cookie holding the access-token JWT — written by the
 *     dashboard AuthBridge from the legacy (localStorage) supabase-js session.
 *     The JWT is validated against the auth server via getUser() (network
 *     check — never trust an unverified token), and all queries run with it
 *     on the Authorization header so RLS applies as the user.
 *
 * No service_role/secret key is ever used here (publishable key only).
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SSR_COOKIE = "sb-portal-auth";
const JWT_COOKIE = "sb_session";

export interface PortalSession {
  user: User;
  supabase: SupabaseClient; // queries run with the user's JWT — RLS enforced
}

/** Validate a JWT against the auth server. Returns the user or null. */
async function validateJwt(jwt: string): Promise<User | null> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) return null;
  return data.user;
}

/** Author queries with the user's JWT on the wire — RLS decides visibility. */
function clientWithJwt(jwt: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

/**
 * Resolve the portal session. Returns null when unauthenticated — callers
 * redirect to /creator/signin (server-side, per the Wave 4 mandate).
 */
export async function getPortalSession(): Promise<PortalSession | null> {
  const cookieStore = await cookies();
  const jwtCookie = cookieStore.get(JWT_COOKIE)?.value;

  // Path 1: ssr-format session (cheap local read — no network). Skipped
  // entirely when no ssr-format cookie exists (legacy flow writes none).
  const hasSsrCookie = cookieStore.getAll().some((c) => c.name.startsWith(SSR_COOKIE));
  if (hasSsrCookie) {
    try {
      const ssr = createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        cookieOptions: { name: SSR_COOKIE },
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            try {
              for (const { name, value, options } of cookiesToSet) {
                cookieStore.set(name, value, options);
              }
            } catch (err) {
              // Server Components cannot mutate cookies — refresh handles it.
              if (process.env.NODE_ENV !== "production") {
                console.warn("[supabase-server] ssr cookie write skipped (RSC render)", err);
              }
            }
          },
        },
      });
      const { data } = await ssr.auth.getSession();
      const session = data.session;
      if (session?.access_token) {
        const user = await validateJwt(session.access_token);
        if (user) return { user, supabase: clientWithJwt(session.access_token) };
      }
    } catch (err) {
      // Malformed/chunked ssr cookies — fall through to the JWT bridge.
      if (process.env.NODE_ENV !== "production") {
        console.warn("[supabase-server] ssr session read failed", err);
      }
    }
  }

  // Path 2: JWT bridge cookie from the legacy localStorage flow.
  if (!jwtCookie) return null;
  const user = await validateJwt(jwtCookie);
  if (!user) return null;
  return { user, supabase: clientWithJwt(jwtCookie) };
}

/** Sign-out: clear every portal auth cookie (Server Action context). */
export async function clearPortalCookies(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(JWT_COOKIE);
  for (const name of cookieStore.getAll().map((c) => c.name)) {
    if (name.startsWith(SSR_COOKIE)) cookieStore.delete(name);
  }
}
