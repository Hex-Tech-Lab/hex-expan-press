import { NextResponse, type NextRequest } from "next/server";
import { createSsrClient } from "../../../src/lib/supabase-ssr";

export const runtime = "nodejs";

/**
 * OAuth/OTP code-exchange callback (Wave 5, PKCE): exchanges the one-time
 * code for a session — the @supabase/ssr client writes the session as
 * strictly HttpOnly cookies. No token is ever exposed to client JS.
 * Errors land back on the sign-in page with an error param.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createSsrClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/creator/dashboard`);
  }

  // Fail-closed redirect with FRAGMENT SANITIZATION (Wave 5.1): if an
  // implicit-flow provider ever appends #access_token=… to this URL, that
  // fragment must not survive into the redirect chain and leak to client JS.
  const safeTarget = new URL("/creator/signin?error=auth", origin);
  safeTarget.hash = "";
  return NextResponse.redirect(safeTarget);
}
