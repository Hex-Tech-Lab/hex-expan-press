"use client";

/**
 * Sign out (Wave 4 review fix): revokes the Supabase session server-side
 * (supabase.auth.signOut invalidates the token AND clears the legacy
 * localStorage session the bridge would otherwise resurrect), then invokes
 * the Server Action to clear the portal cookies and redirect.
 */
import { useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { Icon } from "@iconify/react";
import { signOutAction } from "./actions";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

export default function SignOutButton({ iconsReady }: { iconsReady: boolean }) {
  const [busy, setBusy] = useState(false);

  async function handleSignOut(): Promise<void> {
    setBusy(true);
    try {
      if (SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY) {
        // Full sign-out: revokes the session at the auth server and clears
        // the browser storage the AuthBridge would re-bridge from.
        const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await supabase.auth.signOut();
      }
    } catch (err) {
      console.error("[signout] browser sign-out failed; clearing cookies anyway", err);
    }
    await signOutAction(); // clears portal cookies + redirects (Server Action)
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={busy}
      className="inline-flex items-center gap-2 rounded-lg border border-[#EADFD1] px-4 py-2 text-[length:var(--font-size-sm)] font-semibold text-[#6E5F53] transition-colors hover:bg-[#F3ECDF] hover:text-[#2B2520] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#E8622C] disabled:opacity-60"
    >
      {iconsReady && <Icon icon="lucide:log-out" width={16} height={16} aria-hidden />}
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
