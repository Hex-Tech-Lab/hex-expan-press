"use server";

import { redirect } from "next/navigation";
import { createSsrClient } from "../../../src/lib/supabase-ssr";
import { clearPortalCookies } from "../../../src/lib/supabase-server";

/**
 * Server Action: sign out of the creator portal — revokes the session at
 * the Supabase auth server (real token invalidation, not just a cookie
 * delete), then clears every portal auth cookie and redirects.
 */
export async function signOutAction(): Promise<void> {
  try {
    const supabase = await createSsrClient();
    await supabase.auth.signOut();
  } catch (err) {
    // Revocation is best-effort: cookies are cleared regardless so the
    // portal never stays authenticated on a network blip.
    console.error("[signout] server-side revocation failed; clearing cookies anyway", err);
  }
  await clearPortalCookies();
  redirect("/creator/signin");
}
