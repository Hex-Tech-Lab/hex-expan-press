/**
 * Marketing opt-in persistence (Wave 5): the legacy signin stored this in
 * localStorage; server-side rendering has no browser storage, so it lives in
 * a server cookie until the profile table gains a column.
 */
import { cookies } from "next/headers";

const OPTIN_COOKIE = "ep_marketing_optin";

export async function storeMarketingOptIn(optin: boolean): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(OPTIN_COOKIE, optin ? "true" : "false", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function readMarketingOptIn(): Promise<boolean | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(OPTIN_COOKIE)?.value;
  if (value === undefined) return null;
  return value === "true";
}
