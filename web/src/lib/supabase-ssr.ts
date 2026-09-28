import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import "server-only";

/**
 * @supabase/ssr server client factory for the creator portal (Wave 5).
 *
 * Used by Server Actions (sign-in, sign-out) and the /auth/callback route —
 * contexts where cookie WRITES are allowed, so the ssr client can set and
 * rotate its session cookies (strictly HttpOnly, Secure in production,
 * SameSite=Lax — the @supabase/ssr defaults when managed server-side).
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
    cookieOptions: { name: SSR_COOKIE },
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
