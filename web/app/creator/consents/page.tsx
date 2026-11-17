import type { Metadata } from "next";
import { redirect } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { getPortalSession } from "../../../src/lib/supabase-server";
import { resolvePrimaryProduct } from "../../../src/lib/primary-product";
import { portalConsentState } from "../../../src/lib/consent-chain";
import { loadCreatorConsentRows } from "../../../src/lib/creator-consents";
import { toError } from "../../../src/lib/error-reporting";
import ConsentCards from "./consent-cards";

export const metadata: Metadata = {
  title: "Legal Consents · ExpanPress",
  robots: { index: false, follow: false }, // authenticated surface
};

/**
 * Legal consents (Wave 6.1, RSC — replaces the orphaned legacy static page).
 * Session = ssr HttpOnly cookie, fail-closed server redirect. Reads run
 * under the caller's RLS identity. What is shown as signed follows the same
 * rule as /api/billing/checkout (strict chain head, creator-wide supersession,
 * C2 bound to the product's current release hash), so a button that checkout
 * would refuse is never offered as "done" and a button is offered whenever
 * the release needs signing again.
 */
export default async function ConsentsPage() {
  const session = await getPortalSession();
  if (!session) {
    redirect("/creator/signin");
  }
  const { supabase } = session;

  // Product first (its owner scopes the consent chain), then the owner's complete chain.
  const productRes = await resolvePrimaryProduct<{ id: string; title: string; creator_id: string | null; release_sha256: string | null }>(
    supabase,
    "id, title, creator_id, release_sha256",
  );
  const product = productRes.product;
  if (productRes.error || !product) {
    if (productRes.error) {
      console.error("[consents] products query failed:", productRes.error.message);
      Sentry.captureException(toError(productRes.error), { tags: { surface: "consents", query: "products" } });
    }
    return (
      <ConsentNotice
        title="We couldn't load your consents."
        body="This looks like a temporary problem on our side — please reload in a moment, or contact support@expanpress.com."
      />
    );
  }

  const { rows, error: consentsError } = await loadCreatorConsentRows(supabase, product.creator_id);
  if (consentsError) {
    console.error("[consents] consents query failed:", consentsError.message);
    Sentry.captureException(toError(consentsError), { tags: { surface: "consents", query: "consents" } });
    return (
      <ConsentNotice
        title="We couldn't load your consent states."
        body="Please reload in a moment — your progress is safe."
      />
    );
  }

  const state = portalConsentState(rows, product.id, product.release_sha256);

  return (
    <ConsentCards
      bookTitle={product.title}
      hasC1={state.hasC1}
      hasC2={state.hasC2}
      hasC3={state.hasC3}
    />
  );
}

function ConsentNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-[680px] px-5 py-16" role="alert">
      <h1 className="font-sans text-[length:var(--text-heading-1-size)] font-bold text-[#2B2520]">{title}</h1>
      <p className="mt-2 text-[length:var(--font-size-base)] text-[#6E5F53]">{body}</p>
      <a
        href="/creator/dashboard"
        className="mt-5 inline-block rounded-lg border border-[#EADFD1] px-4 py-2 text-[length:var(--font-size-sm)] font-semibold text-[#6E5F53] hover:bg-[#F3ECDF]"
      >
        Back to dashboard
      </a>
    </div>
  );
}
