import { NextRequest, NextResponse } from "next/server";
import { getPortalSession } from "../../../../src/lib/supabase-server";
import { EnvSettingsAdapter } from "../../../../../src/adapters/settings/env_settings.adapter";
import { createEsignEnvelopeUseCase } from "../../../../../src/use_cases/create_esign_envelope";

export const runtime = "nodejs";

/**
 * E-sign envelope creation (Wave 6, native route handler — replaces the
 * shim-bridged legacy handler). Auth is the HttpOnly ssr session: a missing
 * or invalid session rejects with 401 BEFORE any work. The legacy
 * Authorization-header/service-role path is gone — RLS and the portal
 * session are the only credentials.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getPortalSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let productId: string | undefined;
  try {
    const parsed = (await request.json()) as { productId?: string };
    productId = typeof parsed.productId === "string" ? parsed.productId : undefined;
  } catch {
    // Fixed message only — the raw parse error can embed request-body
    // fragments, which must never land in logs.
    console.warn("[esign/create] rejected malformed JSON body");
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!productId) {
    return NextResponse.json({ ok: false, error: "Missing productId" }, { status: 400 });
  }

  // Host resolution for Firma redirect links: prefer the canonical origin,
  // fall back to the request Host header (covers preview deployments).
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "expanpress.com";
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  const hostUrl = process.env.NEXT_PUBLIC_SITE_ORIGIN ?? `${forwardedProto}://${forwardedHost}`;

  try {
    const result = await createEsignEnvelopeUseCase(
      { productId, userId: session.user.id, userEmail: session.user.email ?? "", hostUrl },
      new EnvSettingsAdapter(),
    );
    return NextResponse.json({ ok: true, url: result.signUrl });
  } catch (err) {
    console.error("[esign/create] envelope creation failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (/insufficient credits|402/i.test(msg)) {
      return NextResponse.json(
        { ok: false, error: "The signing service is awaiting credit activation. Please try again shortly." },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: "Internal Server Error" }, { status: 500 });
  }
}
