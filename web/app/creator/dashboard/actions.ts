"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { createSsrClient } from "../../../src/lib/supabase-ssr";
import { clearPortalCookies, getPortalSession } from "../../../src/lib/supabase-server";
import { EnvSettingsAdapter } from "../../../../src/adapters/settings/env_settings.adapter";
import { resolvePrimaryProduct } from "../../../src/lib/primary-product";
import { supersededConsentIds } from "../../../src/lib/consent-chain";
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
 * signed-in creator's product and redirects to the signing flow. Auth is
 * the HttpOnly ssr session (fail-closed), the product is resolved through
 * RLS (products_read via my_creator_ids), and Firma errors surface as
 * dashboard error params — never as raw exceptions.
 */
export async function startPublisherAgreementAction(): Promise<void> {
  const session = await getPortalSession();
  if (!session) redirect("/creator/signin");
  const { user, supabase } = session;

  // Prerequisite chain verification (sprint 14 ARTAS Track A2):
  // C3 publisher agreement requires the ENTIRE prerequisite chain (both C1 AND C2)
  // to be actively given on the creator's primary product.
  // Query all C1 and C2 rows for this creator (RLS-scoped).
  const { data: consents, error: consentsError } = await supabase
    .from("consents")
    .select("product_id, kind, decision, signed_at, id, supersedes")
    .in("kind", ["C1_data_accuracy", "C2_release_approval"]);

  if (consentsError || !consents || consents.length === 0) {
    redirect("/creator/dashboard?error=c2_required");
  }

  // Resolve active chain heads per kind — supersession comes from the SHARED
  // resolver (consent-chain.ts) so a malformed cross-kind pointer (e.g. a C2
  // row pointing at a C1 row) can never invalidate a valid head here, exactly
  // matching what activeConsentKinds (checkout gate / consents page) sees.
  const supersededIds = supersededConsentIds(consents);

  const c1Heads = consents.filter((c) => c.kind === "C1_data_accuracy" && !supersededIds.has(c.id));
  const c2Heads = consents.filter((c) => c.kind === "C2_release_approval" && !supersededIds.has(c.id));

  if (c1Heads.length !== 1 || c2Heads.length !== 1) {
    redirect("/creator/dashboard?error=c2_required");
  }

  const c1Head = c1Heads[0];
  const c2Head = c2Heads[0];

  if (c1Head.decision !== "given" || !c1Head.product_id || c2Head.decision !== "given" || !c2Head.product_id) {
    redirect("/creator/dashboard?error=c2_required");
  }

  // Every portal status surface (dashboard, consents page, esign_done) reads the PRIMARY product,
  // so the C3 envelope may only be created for it — both C1 and C2 must bind to it.
  const { product: primary } = await resolvePrimaryProduct<{ id: string }>(supabase, "id");
  if (!primary || primary.id !== c2Head.product_id || primary.id !== c1Head.product_id) {
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
    const msg = err instanceof Error ? err.message : String(err);
    redirect(/insufficient credits|402/i.test(msg) ? "/creator/dashboard?error=credits" : "/creator/dashboard?error=esign");
  }
}
