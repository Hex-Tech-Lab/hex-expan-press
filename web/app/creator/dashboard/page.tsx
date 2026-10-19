import { redirect } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { getPortalSession } from "../../../src/lib/supabase-server";
import { resolvePrimaryProduct } from "../../../src/lib/primary-product";
import { activeConsentKinds } from "../../../src/lib/consent-chain";
import DashboardClient from "./dashboard-client";
import { reviewProgress } from "./progress";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Creator Portal · ExpanPress",
  robots: { index: false, follow: false }, // authenticated surface
};

/**
 * Creator dashboard — RSC (Wave 4), auth hardened (Wave 5).
 *
 * Wave 5: the only session source is the @supabase/ssr HttpOnly cookie
 * (written server-side by /auth/callback and the signin Server Actions).
 * The legacy AuthBridge localStorage->JWT-cookie path is retired — no
 * JS-readable token exists anymore. No valid cookie -> server-side redirect
 * to /creator/signin. No dashboard data is ever rendered without a
 * validated session (getUser validates against the auth server).
 */

/** Journey state mapping (Wave 4 mandate, founder contract): the tracker
 * tracks LEGAL milestones only — it advances on signed consents regardless of
 * manuscript answer count; review progress lives on the Step 1 card status.
 *   Step 1 (Bio/Content)  — user exists, C1/C2 pending
 *   Step 2 (Legal/Assets) — C1+C2 signed, C3 pending
 *   Step 3 (Rev/Publish)  — C3 executed */
function computeJourneyStep(state: { hasC1: boolean; hasC2: boolean; hasC3: boolean }): 0 | 1 | 2 {
  return state.hasC3 ? 2 : state.hasC1 && state.hasC2 ? 1 : 0;
}

const ACTION_ERRORS = ["credits", "esign", "no_product", "c2_required"] as const;
type ActionError = (typeof ACTION_ERRORS)[number];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Single auth path: ssr-format HttpOnly cookie -> server-validated session.
  const session = await getPortalSession();
  if (!session) {
    redirect("/creator/signin");
  }

  // Step 3 Server Action failures land back here as ?error= — validated
  // against the known codes so arbitrary query strings stay inert.
  const params = await searchParams;
  const actionError = ACTION_ERRORS.includes(params.error as ActionError)
    ? (params.error as ActionError)
    : undefined;

  const { user, supabase } = session;

  // Profile and primary product resolved first
  const [profileRes, productRes] = await Promise.all([
    supabase.from("profiles").select("full_name, email").eq("user_id", user.id).maybeSingle(),
    resolvePrimaryProduct<{ id: string }>(supabase, "id"),
  ]);

  const product = productRes.product;

  // Review items and consents scoped strictly to the primary product
  const [itemsRes, consentsRes] = product
    ? await Promise.all([
        supabase
          .from("review_items")
          .select("id, product_id, code")
          .eq("product_id", product.id)
          .order("code", { ascending: true })
          .limit(500),
        // Chain-head resolution needs ALL decisions + supersedes pointers
        supabase
          .from("consents")
          .select("id, kind, decision, product_id, supersedes")
          .eq("product_id", product.id)
          .order("signed_at", { ascending: false })
          .limit(500),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];

  const itemIds = (itemsRes.data ?? []).map((it) => it.id);
  const answersRes =
    itemIds.length > 0
      ? await supabase
          .from("review_answers")
          .select("item_id, answered_at")
          .in("item_id", itemIds)
          .order("answered_at", { ascending: false })
          .limit(500)
      : { data: [], error: null };

  const failed = (
    [
      ["profiles", profileRes],
      ["products", productRes],
      ["review_items", itemsRes],
      ["review_answers", answersRes],
      ["consents", consentsRes],
    ] as const
  ).filter(([, res]) => res.error);
  if (failed.length > 0) {
    // A query failure must never read as "no progress" — render a recoverable
    // error state and capture for observability instead of fake-empty data.
    for (const [label, res] of failed) {
      const err = res.error;
      if (!err) continue;
      console.error(`[dashboard] ${label} query failed:`, err.message);
      Sentry.captureException(err, { tags: { surface: "dashboard", query: label } });
    }
    return (
      <div className="mx-auto max-w-[680px] px-5 py-12" role="alert">
          <h1 className="font-serif text-2xl font-bold text-[#2B2520]">We couldn&apos;t load your dashboard.</h1>
          <p className="mt-2 text-sm text-[#6E5F53]">
            This looks like a temporary problem on our side — your work is safe. Please reload in a moment.
          </p>
          <a
            href="/creator/dashboard"
            className="mt-5 inline-block rounded-lg border border-[#EADFD1] px-4 py-2 text-sm font-semibold text-[#6E5F53] hover:bg-[#F3ECDF]"
          >
            Reload dashboard
          </a>
        </div>
    );
  }

  const name = profileRes.data?.full_name || user.email || "";
  const email = profileRes.data?.email || user.email || "";
  // Mirror the review page's data model: the creator's first product, the
  // review items belonging to it, and answers counted as DISTINCT item_ids.
  const { answered, total } = reviewProgress(itemIds, (answersRes.data ?? []).map((a) => a.item_id));
  // NOTE: DB enum kind is C2_release_approval (the legacy HTML checked a
  // non-existent "C2_marketing_release" — step 2 could never complete there).
  // Same product binding as the consents page and esign_done: only the primary product's consents count.
  const active = activeConsentKinds(consentsRes.data ?? [], product?.id);
  const hasC1 = active.has("C1_data_accuracy");
  const hasC2 = active.has("C2_release_approval");
  const hasC3 = active.has("C3_revenue_split");

  const journeyActive = computeJourneyStep({ hasC1, hasC2, hasC3 });

  const clientActionError =
    actionError && actionError !== "c2_required" ? actionError : undefined;

  return (
    <>
      {actionError === "c2_required" && (
        <div className="mx-auto max-w-[680px] px-5 pt-8">
          <p
            className="mb-3.5 rounded-xl border border-[#EADFD1] bg-[#F3ECDF] p-[var(--space-4)] text-[length:var(--font-size-sm)] font-medium text-[#8A4B2D]"
            role="alert"
          >
            Please approve the release (step 2) before signing the publisher agreement.
          </p>
        </div>
      )}
      <DashboardClient
        name={name}
        email={email}
        answersCount={answered}
        answersTarget={total}
        hasC1={hasC1}
        hasC2={hasC2}
        hasC3={hasC3}
        journeyActive={journeyActive}
        actionError={clientActionError}
      />
    </>
  );
}

