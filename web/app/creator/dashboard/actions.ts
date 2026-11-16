"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { createSsrClient } from "../../../src/lib/supabase-ssr";
import { clearPortalCookies, getVerifiedPortalSession } from "../../../src/lib/supabase-server";
import { EnvSettingsAdapter } from "../../../../src/adapters/settings/env_settings.adapter";
import { resolvePrimaryProduct } from "../../../src/lib/primary-product";
import { portalConsentState } from "../../../src/lib/consent-chain";
import { loadCreatorConsentRows } from "../../../src/lib/creator-consents";
import { createEsignEnvelopeUseCase } from "../../../../src/use_cases/create_esign_envelope";

/**
 * Server Action: sign out of the creator portal — revokes the session at
 * the Supabase auth server (real token invalidation, not just a cookie
 * delete), then clears every portal auth cookie and redirects.
 */
export async function signOutAction(): Promise<void> {
  try {
    const supabase = await createSsrClient();
    const { error } = await supabase.auth.signOut();
    // signOut RESOLVES with an error on some revocation failures — surface
    // it (Sentry sees server console errors) but clear cookies regardless:
    // the portal must never stay authenticated on a revocation blip.
    if (error) console.error("[signout] remote revocation failed", error);
  } catch (err) {
    console.error("[signout] server-side revocation threw; clearing cookies anyway", err);
  }
  await clearPortalCookies();
  redirect("/creator/signin");
}

/**
 * Step 3 (Wave 6): creates the Firma publisher-agreement envelope for the
 * signed-in creator's primary product and redirects to the signing flow.
 *
 * Gate: the session is verified against the auth server with the explicit
 * access token (getVerifiedPortalSession), so a revoked session is refused.
 * The C3 envelope is created only when the creator-wide strict chain shows C1
 * and C2 both signed on the primary product, using the same rule as the
 * dashboard and the checkout gate (portalConsentState): one strict head per
 * kind, supersession resolved across the creator's complete history, and C2
 * approving the product's CURRENT release hash. Firma errors surface as
 * dashboard error params, never as raw exceptions.
 */
export async function startPublisherAgreementAction(): Promise<void> {
  const session = await getVerifiedPortalSession();
  if (!session) redirect("/creator/signin");
  const { supabase, user } = session;

  // Every portal status surface reads the PRIMARY product, so the C3 envelope may only be created for it.
  const { product: primary } = await resolvePrimaryProduct<{
    id: string;
    creator_id: string | null;
    release_sha256: string | null;
  }>(supabase, "id, creator_id, release_sha256");
  if (!primary || !primary.id) {
    redirect("/creator/dashboard?error=c2_required");
  }

  // Creator-wide read: a successor on any product of this creator can supersede a row here.
  // A read error or a truncated history (safety cap) fails closed.
  const { rows, error: consentsError } = await loadCreatorConsentRows(supabase, primary.creator_id);
  if (consentsError) {
    redirect("/creator/dashboard?error=c2_required");
  }

  // C1 and C2 must each be the single strict head of their kind, given, and (C2) bound to the current release.
  const state = portalConsentState(rows, primary.id, primary.release_sha256);
  if (!state.hasC1 || !state.hasC2) {
    redirect("/creator/dashboard?error=c2_required");
  }

  const productId = primary.id;
  const siteOrigin = process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "https://expanpress.com";
  try {
    const result = await createEsignEnvelopeUseCase(
      { productId, userId: user.id, userEmail: user.email ?? "", hostUrl: siteOrigin },
      new EnvSettingsAdapter(),
    );
    redirect(result.signUrl);
  } catch (err) {
    // redirect() unwinds by throwing NEXT_REDIRECT — it must pass through,
    // or a SUCCESSFUL envelope creation would be eaten by this catch and
    // misreported as an esign failure (caught in Wave 6 review 2026-09-29).
    unstable_rethrow(err); // re-throw Next navigation signals (redirect/notFound) untouched
    console.error("[dashboard] envelope creation failed:", err);
    const causeStr = err instanceof Error && err.cause
      ? (typeof AggregateError !== "undefined" && err.cause instanceof AggregateError
          ? err.cause.errors.map((e) => (e instanceof Error ? e.message : String(e))).join(" ")
          : String(err.cause))
      : "";
    const msg = err instanceof Error ? `${err.message} ${causeStr}` : String(err);
    const hasStatus402 = (err as unknown as { status?: number })?.status === 402 ||
      (typeof AggregateError !== "undefined" && err instanceof Error && err.cause instanceof AggregateError &&
        err.cause.errors.some((e) => (e as unknown as { status?: number })?.status === 402));
    const isCreditError = hasStatus402 || /\b402\b|insufficient[ _]credits/i.test(msg);
    redirect(isCreditError ? "/creator/dashboard?error=credits" : "/creator/dashboard?error=esign");
  }
}
