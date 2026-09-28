"use client";

/**
 * AuthBridge — client-side session → cookie handshake for the RSC dashboard.
 *
 * The legacy sign-in flow (OAuth/OTP, static HTML) stores its Supabase session
 * in localStorage; a Server Component can never read that. This bridge:
 *  1. Detects an OAuth/OTP hash return (#access_token=…, handled natively by
 *     supabase-js detectSessionInUrl) or an existing localStorage session.
 *  2. Writes the short-lived `sb_session` cookie (the JWT) so the server can
 *     hydrate the dashboard.
 *  3. Strips the hash and refreshes the route so the RSC re-renders with the
 *     cookie present.
 *
 * Wave 5 will move sign-in into the app with @supabase/ssr-native cookies and
 * retire this bridge.
 */
import { createClient } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

export default function AuthBridge({ mustHaveSession = false }: { mustHaveSession?: boolean }): null {
  const router = useRouter();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

    async function bridge(): Promise<void> {
      // getUser() (not getSession): validates against the auth server and
      // refreshes an expired localStorage session in one call.
      const { data, error } = await supabase.auth.getUser();
      const user = data.user;

      if (error || !user) {
        if (mustHaveSession) {
          window.location.replace("/creator/signin"); // no recoverable session
        }
        return;
      }

      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;

      const hadCookie = document.cookie.includes("sb_session=");
      const maxAge = Math.max(300, Math.min(sess.session?.expires_in ?? 3600, 3600));
      document.cookie = `sb_session=${token}; path=/; Secure; SameSite=Lax; Max-Age=${maxAge}`;

      if (window.location.hash.includes("access_token")) {
        // OAuth/OTP return: strip sensitive tokens from the URL bar.
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }

      if (!hadCookie) {
        router.refresh(); // re-run the RSC with the cookie present
      }
    }

    void bridge();
  }, [router, mustHaveSession]);

  return null;
}
