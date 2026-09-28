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

async function resolveOrigin(): Promise<string> {
  // Strictly production keeps the canonical pin: the OAuth provider
  // allow-list and every deployed asset expect one domain there.
  if (process.env.VERCEL_ENV === "production") {
    return process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "https://expanpress.com";
  }
  // Previews/local: bind the OAuth round-trip to the EXACT host the user is
  // on (request-scoped, not env-scoped). The PKCE verifier cookie is
  // host-scoped — a redirectTo on any other domain alias (pinned env origin,
  // bare VERCEL_URL vs the open deployment alias) makes Google return to a
  // host where that cookie does not exist, and the exchange fails as
  // "Sign-in link expired or already used" (P0 2026-09-29, founder report).
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/** Google OAuth via PKCE — the ssr client persists the verifier in a cookie. */
export async function signInWithGoogleAction(): Promise<void> {
  void headers; // Server Action context; origin resolved from env (static host)
  const origin = await resolveOrigin();
  try {
    const supabase = await createSsrClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}/auth/callback` },
    });
    if (error || !data.url) redirect("/creator/signin?error=oauth");
    redirect(data.url);
  } catch (err) {
    // Env gaps must surface as the OAuth error param, never an action crash
    // (same defect class as the 2026-09-29 middleware/callback P0 fix).
    if (err && typeof err === "object" && "digest" in err) throw err; // re-throw NEXT_REDIRECT
    console.error("[signin/google] failed:", err instanceof Error ? err.message : err);
    redirect("/creator/signin?error=oauth");
  }
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

  const origin = await resolveOrigin();
  try {
    const supabase = await createSsrClient();
    const { data, error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${origin}/auth/callback` },
    });
    if (error) redirect("/creator/signin?error=otp");
    // Auto-confirm projects return the session INLINE (no email leg) — the ssr
    // client has already written the HttpOnly cookies, so land the creator
    // straight on the dashboard. Email-confirm projects (our production state)
    // fall through to the "check your inbox" notice.
    if (data.session) redirect("/creator/dashboard");
    redirect("/creator/signin?sent=1");
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err; // re-throw NEXT_REDIRECT
    console.error("[signin/otp] failed:", err instanceof Error ? err.message : err);
    redirect("/creator/signin?error=otp");
  }
}

/** Marketing opt-in preference (legacy signin persisted it client-side). */
export async function setMarketingOptInAction(formData: FormData): Promise<void> {
  const optin = formData.get("optin") === "on";
  // Preference storage is a server cookie; the Supabase client is not needed
  // for this action (profile-table storage lands with the portal work).
  // Await BEFORE the redirect — a Server Action redirect aborts remaining
  // execution, so a fire-and-forget write silently loses the preference
  // (Wave 5.1 race-condition fix).
  const { storeMarketingOptIn } = await import("../../../src/lib/marketing-optin");
  await storeMarketingOptIn(optin);
  redirect("/creator/signin?optin=1");
}
