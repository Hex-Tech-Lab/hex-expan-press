import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import "server-only";
import { jwtSkewRetryDelayMs } from "../../../payments/src/settings_registry";
import { createSkewRetryFetch } from "./skew-retry-fetch";

/**
 * @supabase/ssr server client factory for the creator portal (Wave 5).
 *
 * Used by Server Actions (sign-in, sign-out) and the /auth/callback route —
 * contexts where cookie WRITES are allowed, so the ssr client can set and
 * rotate its session cookies. HttpOnly is enforced EXPLICITLY here: the
 * @supabase/ssr default is httpOnly:false (verified in v0.12.7 constants.js)
 * and a JS-readable session token is the exact vulnerability Wave 5 exists
 * to eliminate. Secure only in production (local http dev would drop it).
 *
 * Cookie name matches supabase-server.ts (SSR_COOKIE) so getPortalSession
 * reads the same session. Publishable key only — no service role here.
 */
const SSR_COOKIE = "sb-portal-auth";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

export async function createSsrClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    // AGY audit 2.1 (sprint 12 B2): the auth-server/GoTrue boundary can mint a
    // JWT whose `iat` sits a few seconds in the future (clock drift between
    // Vercel serverless containers and Supabase) — the first PostgREST/Auth
    // read then fails 401 PGRST303 with no retry. Wire the same one-shot skew
    // retry the JWT-scoped client already has (supabase-server.ts).
    // Sprint-13 (ADR-0059): the retry is now GATED to GET/HEAD inside
    // createSkewRetryFetch itself — mutations are returned untouched on any
    // 401, so a mutation replay is structurally impossible (the old
    // safety argument "PGRST303 is rejected pre-transaction" was behavioral;
    // the method gate makes it structural).
    global: {
      fetch: createSkewRetryFetch(fetch, jwtSkewRetryDelayMs()),
    },
    cookieOptions: {
      name: SSR_COOKIE,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });
}
