import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Sentry from "@sentry/nextjs";
import { getPortalSession } from "../../../src/lib/supabase-server";
import DashboardClient from "./dashboard-client";
import AuthBridge from "./auth-bridge";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Creator Portal · ExpanPress",
  robots: { index: false, follow: false }, // authenticated surface
};

/**
 * Creator dashboard — RSC (Wave 4). Replaces the vanilla HTML portal that
 * fetched with client-side document.getElementById + localStorage sessions.
 *
 * Auth flow (three cases):
 *   a) No cookie at all — first land or OAuth/OTP return. The server cannot
 *      see localStorage sessions, so it renders the AuthBridge shell; the
 *      bridge establishes the cookie (or redirects to signin client-side).
 *   b) Cookie present but invalid/expired — server-side redirect to
 *      /creator/signin (the security-enforced path; getUser is validated
 *      against the auth server, never trusted locally).
 *   c) Cookie valid — server hydrates profile + consents + review progress.
 * No dashboard data is ever rendered without a validated session.
 */

const REVIEW_ANSWER_TARGET = 29;

/** Journey state mapping (Wave 4 mandate, founder contract): the tracker
 * tracks LEGAL milestones only — it advances on signed consents regardless of
 * manuscript answer count; review progress lives on the Step 1 card status.
 *   Step 1 (Bio/Content)  — user exists, C1/C2 pending
 *   Step 2 (Legal/Assets) — C1+C2 signed, C3 pending
 *   Step 3 (Rev/Publish)  — C3 executed */
function computeJourneyStep(state: { hasC1: boolean; hasC2: boolean; hasC3: boolean }): 0 | 1 | 2 {
  return state.hasC3 ? 2 : state.hasC1 && state.hasC2 ? 1 : 0;
}

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const hasJwtCookie = cookieStore.get("sb_session")?.value;
  // Any portal cookie (JWT bridge or ssr-format) means server validation owns
  // the decision; the bridge only handles the truly cookie-less first land.
  const hasPortalCookie =
    Boolean(hasJwtCookie) || cookieStore.getAll().some((c) => c.name.startsWith("sb-portal-auth"));

  // Case (a): no cookie — the bridge resolves localStorage/hash sessions.
  if (!hasPortalCookie) {
    return (
      <>
        <AuthBridge mustHaveSession />
        <DashboardShellLoading />
      </>
    );
  }

  // Case (b): cookie present but not valid — server-side redirect.
  const session = await getPortalSession();
  if (!session) {
    redirect("/creator/signin");
  }

  const { user, supabase } = session;

  // Independent reads run in parallel (async-avoid-waterfall).
  const [profileRes, answersRes, consentsRes] = await Promise.all([
    supabase.from("profiles").select("name, email").eq("id", user.id).maybeSingle(),
    supabase.from("review_answers").select("id", { count: "exact" }),
    supabase.from("consents").select("kind, decision").eq("decision", "given"),
  ]);

  const failed = (
    [
      ["profiles", profileRes],
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
      <>
        <AuthBridge />
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
      </>
    );
  }

  const name = profileRes.data?.name || user.email || "";
  const email = profileRes.data?.email || user.email || "";
  const answersCount = answersRes.count ?? 0;
  // NOTE: DB enum kind is C2_release_approval (the legacy HTML checked a
  // non-existent "C2_marketing_release" — step 2 could never complete there).
  const given = new Set((consentsRes.data ?? []).map((c) => c.kind));
  const hasC1 = given.has("C1_data_accuracy");
  const hasC2 = given.has("C2_release_approval");
  const hasC3 = given.has("C3_revenue_split");

  const journeyActive = computeJourneyStep({ hasC1, hasC2, hasC3 });

  return (
    <>
      <DashboardClient
        name={name}
        email={email}
        answersCount={answersCount}
        answersTarget={REVIEW_ANSWER_TARGET}
        hasC1={hasC1}
        hasC2={hasC2}
        hasC3={hasC3}
        journeyActive={journeyActive}
      />
    </>
  );
}

/** Loading shell shown while the AuthBridge resolves a localStorage session. */
function DashboardShellLoading(): React.ReactNode {
  return (
    <div className="mx-auto max-w-[680px] px-5 py-12">
      <p className="text-sm text-[#6E5F53]">Loading your dashboard&hellip;</p>
    </div>
  );
}
