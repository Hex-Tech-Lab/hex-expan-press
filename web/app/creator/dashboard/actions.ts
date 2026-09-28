"use server";

import { clearPortalCookies } from "../../../src/lib/supabase-server";
import { redirect } from "next/navigation";

/** Server Action: sign out of the creator portal (clears cookies server-side). */
export async function signOutAction(): Promise<void> {
  await clearPortalCookies();
  redirect("/creator/signin");
}
