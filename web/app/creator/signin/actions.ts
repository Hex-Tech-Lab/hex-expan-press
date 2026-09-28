"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSsrClient } from "../../../src/lib/supabase-ssr";

/**
 * Sign-in Server Actions (Wave 5): authentication lives entirely server-side.
 * Tokens never reach client JS — the @supabase/ssr client writes the session
 * as HttpOnly cookies (Secure in production, SameSite=Lax) on the
 * /auth/callback code exchange.
 */

function resolveOrigin(): string {
  if (process.env.NEXT_PUBLIC_SITE_ORIGIN) return process.env.NEXT_PUBLIC_SITE_ORIGIN;
  const host = process.env.VERCEL_URL ?? "expanpress.com";
  const proto = process.env.VERCEL_ENV === "production" ? "https" : "https";
  return `${proto}://${host}`;
}

/** Google OAuth via PKCE — the ssr client persists the verifier in a cookie. */
export async function signInWithGoogleAction(): Promise<void> {
  void headers; // Server Action context; origin resolved from env (static host)
  const origin = resolveOrigin();
  const supabase = await createSsrClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback` },
  });
  if (error || !data.url) redirect("/creator/signin?error=oauth");
  redirect(data.url);
}

/**
 * Email OTP magic link. The Supabase project (verified live 2026-09-28:
 * /auth/v1/settings — email:true, mailer_autoconfirm:false) sends a magic
 * link that lands on /auth/callback; if the project forced the implicit
 * (hash-token) flow instead of PKCE, the AuthBridge fallback on the
 * dashboard remains until the config is migrated.
 */
export async function signInWithOtpAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email || !email.includes("@")) redirect("/creator/signin?error=invalid_email");

  const origin = resolveOrigin();
  const supabase = await createSsrClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) redirect("/creator/signin?error=otp");
  redirect("/creator/signin?sent=1");
}

/** Marketing opt-in preference (legacy signin persisted it client-side). */
export async function setMarketingOptInAction(formData: FormData): Promise<void> {
  const optin = formData.get("optin") === "on";
  const supabase = await createSsrClient();
  void supabase; // preference storage lands with the portal profile work
  const { storeMarketingOptIn } = await import("../../../src/lib/marketing-optin");
  storeMarketingOptIn(optin);
  redirect("/creator/signin?optin=1");
}
