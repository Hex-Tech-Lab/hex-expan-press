"use client";

/**
 * Sign out (Wave 5): the Server Action revokes the Supabase session
 * server-side (supabaseSSR.auth.signOut invalidates the token at the auth
 * server) and clears the HttpOnly ssr cookies — no browser client needed,
 * no JS-readable token ever existed in this flow.
 */
import { useState } from "react";
import { Icon } from "@iconify/react";
import { BrandButton } from "../../../src/components/brand/brand";
import { signOutAction } from "./actions";

export default function SignOutButton({ iconsReady }: { iconsReady: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await signOutAction(); // server-side revoke + cookie clear + redirect
    } catch (err) {
      console.error("[signout] sign-out failed", err);
      setError("Sign out failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <BrandButton
        variant="secondary"
        type="button"
        onClick={handleSignOut}
        disabled={busy}
        className="px-4 py-2"
      >
        {iconsReady && <Icon icon="lucide:log-out" width={16} height={16} aria-hidden />}
        {busy ? "Signing out…" : "Sign out"}
      </BrandButton>
      {error && (
        <span role="alert" className="text-sm font-medium text-[#B3401E]">
          {error}
        </span>
      )}
    </div>
  );
}
