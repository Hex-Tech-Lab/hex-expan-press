"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { createSsrClient } from "../../../src/lib/supabase-ssr";
import { clearPortalCookies, getPortalSession } from "../../../src/lib/supabase-server";
import { EnvSettingsAdapter } from "../../../../src/adapters/settings/env_settings.adapter";
import { resolvePrimaryProduct } from "../../../src/lib/primary-product";
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

  // C3 binds to the product on which this creator's C2 (release approval) is currently given:
  // the supersedes-chain head of their C2 rows (RLS-scoped). No head, several heads (e.g. two
  // products) or a non-given head fails closed — the envelope is never created on a guess.
  const { data: consents, error: consentsError } = await supabase
    .from("consents")
    .select("product_id, kind, decision, signed_at, id, supersedes")
    .eq("kind", "C2_release_approval");

  if (consentsError || !consents || consents.length === 0) {
    redirect("/creator/dashboard?error=c2_required");
  }

  const supersededIds = new Set(
    consents.map((c) => c.supersedes).filter((s): s is string => typeof s === "string" && s.length > 0)
  );
  const heads = consents.filter((c) => !supersededIds.has(c.id));

  if (heads.length !== 1) {
    redirect("/creator/dashboard?error=c2_required");
  }

  const head = heads[0];
  if (head.decision !== "given" || !head.product_id) {
    redirect("/creator/dashboard?error=c2_required");
  }

  // Every portal status surface (dashboard, consents page, esign_done) reads the PRIMARY product,
  // so the C3 envelope may only be created for it — otherwise signing could succeed while those
  // pages still show C3 as unsigned. Mismatch fails closed.
  const { product: primary } = await resolvePrimaryProduct<{ id: string }>(supabase, "id");
  if (!primary || primary.id !== head.product_id) {
    redirect("/creator/dashboard?error=c2_required");
  }
  const productId = head.product_id;

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
