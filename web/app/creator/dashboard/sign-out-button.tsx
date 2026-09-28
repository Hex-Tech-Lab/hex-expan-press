"use client";

/**
 * Sign out (Wave 5): the Server Action revokes the Supabase session
 * server-side (supabaseSSR.auth.signOut invalidates the token at the auth
 * server) and clears the HttpOnly ssr cookies — no browser client needed,
 * no JS-readable token ever existed in this flow.
 */
import { useState } from "react";
import { Icon } from "@iconify/react";
import { signOutAction } from "./actions";

export default function SignOutButton({ iconsReady }: { iconsReady: boolean }) {
  const [busy, setBusy] = useState(false);

  async function handleSignOut(): Promise<void> {
    setBusy(true);
    try {
      await signOutAction(); // server-side revoke + cookie clear + redirect
    } finally {
      setBusy(false);
    }
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
