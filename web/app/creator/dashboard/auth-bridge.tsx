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
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import { decideBridgeAction } from "../../../src/lib/auth-bridge-core";

// NEXT_PUBLIC_ prefix required: unprefixed env vars never reach browser bundles.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

export default function AuthBridge({ mustHaveSession = false }: { mustHaveSession?: boolean }): null {
  const router = useRouter();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

    async function bridge(): Promise<void> {
      // Missing client config cannot recover here — fail safe to sign-in.
      if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
        console.error("[auth-bridge] missing NEXT_PUBLIC_SUPABASE_* configuration");
        if (mustHaveSession) window.location.replace("/creator/signin");
        return;
      }

      // getUser() (not getSession): validates against the auth server and
      // refreshes an expired localStorage session in one call. Bounded retry
      // for transient network failures — never hang on the loading shell.
      let user = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { data } = await supabase.auth.getUser();
          user = data.user;
          if (user) break;
        } catch (err) {
          console.warn("[auth-bridge] getUser attempt failed (will retry once)", err);
        }
        if (attempt === 0 && !user) await new Promise((r) => setTimeout(r, 1500));
      }

      const hadCookie = document.cookie.includes("sb_session=");
      const action = decideBridgeAction({
        userPresent: Boolean(user),
        hadCookie,
        hashHasToken: window.location.hash.includes("access_token"),
      });

      if (action.redirectToSignin) {
        window.location.replace("/creator/signin"); // no recoverable session
        return;
      }
      if (action.writeCookie) {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (token) {
          const maxAge = Math.max(300, Math.min(sess.session?.expires_in ?? 3600, 3600));
          document.cookie = `sb_session=${token}; path=/; Secure; SameSite=Lax; Max-Age=${maxAge}`;
        }
      }
      if (action.stripHash) {
        // OAuth/OTP return: strip sensitive tokens from the URL bar.
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      if (action.refresh) {
        router.refresh(); // re-run the RSC with the cookie present
      }
    }

    bridge().catch((err) => {
      console.error("[auth-bridge] failed", err);
      if (mustHaveSession) window.location.replace("/creator/signin");
    });
  }, [router, mustHaveSession]);

  return null;
}
