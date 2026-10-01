import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createSsrClient } from "../../../src/lib/supabase-ssr";

export const runtime = "nodejs";

// Passwordless app: recovery/invite/email_change links are not issued by us and fail closed.
const OTP_TYPES = ["magiclink", "email", "signup"] as const;

/**
 * Auth callback, two flows:
 * 1. OAuth/PKCE code exchange (?code=…): exchanges the one-time code for a
 *    session — the @supabase/ssr client writes the session as strictly
 *    HttpOnly cookies. No token is ever exposed to client JS.
 * 2. Email OTP verification (?token_hash=…&type=…): verifies the hashed token
 *    from magic-link/signup/email mails and establishes the session the
 *    same way.
 * Errors land back on the sign-in page with an error param.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const otpType = searchParams.get("type");
  const validOtpType = OTP_TYPES.find((t) => t === otpType) as EmailOtpType | undefined;

  if (code || (tokenHash && validOtpType)) {
    try {
      // Construction INSIDE the failure boundary (P0 2026-09-29, same class
      // as the middleware fix): an env gap must fail closed to the sign-in
      // redirect, never 500 the callback route.
      const supabase = await createSsrClient();
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) return NextResponse.redirect(`${origin}/creator/dashboard`);
      } else if (tokenHash && validOtpType) {
        const { error } = await supabase.auth.verifyOtp({ type: validOtpType, token_hash: tokenHash });
        if (!error) return NextResponse.redirect(`${origin}/creator/dashboard`);
        console.error("[auth/callback] otp verify failed:", error.message);
      }
    } catch (err) {
      // Unexpected throws (e.g. unconfigured Supabase env) — log for
      // observability, then the fail-closed redirect below still runs.
      console.error("[auth/callback] exchange failed:", err instanceof Error ? err.message : err);
    }
  }

  // Fail-closed redirect with FRAGMENT SANITIZATION (Wave 5.1): if an
  // implicit-flow provider ever appends #access_token=… to this URL, that
  // fragment must not survive into the redirect chain and leak to client JS.
  const safeTarget = new URL("/creator/signin?error=auth", origin);
  safeTarget.hash = "";
  return NextResponse.redirect(safeTarget);
}
