import type { Metadata } from "next";
import { redirect } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { GLOBAL } from "../../../../payments/src/settings_registry";
import { getPortalSession } from "../../../src/lib/supabase-server";
import { resolvePrimaryProduct } from "../../../src/lib/primary-product";
import { portalConsentState } from "../../../src/lib/consent-chain";
import { loadCreatorConsentRows } from "../../../src/lib/creator-consents";
import { toError } from "../../../src/lib/error-reporting";
import { BrandButton, BrandFooter, BrandFrame, BrandWordmark } from "../../../src/components/brand/brand";
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
        body={`This looks like a temporary problem on our side — please reload in a moment, or contact ${GLOBAL.email.support}.`}
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
      supportEmail={GLOBAL.email.support}
    />
  );
}

function ConsentNotice({ title, body }: { title: string; body: string }) {
  return (
    <BrandFrame outerClassName="justify-between">
      <header className="flex items-center justify-between">
        <BrandWordmark href="/creator/dashboard" label="Creator dashboard" />
      </header>
      <main className="mx-auto w-full max-w-[680px] glass-card card-shadow rounded-[32px] border-[1.5px] border-[#fff2e4] p-6 sm:p-8" role="alert">
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        <p className="mt-2 text-base text-gray-700">{body}</p>
        <BrandButton variant="secondary" href="/creator/dashboard" className="mt-5 min-h-11 px-4 py-2">
          Back to dashboard
        </BrandButton>
      </main>
      <BrandFooter>
        <a href="/privacy.html" className="hover:text-gray-700 transition-colors">Privacy Policy</a>
        <a href="/terms.html" className="hover:text-gray-700 transition-colors">Terms of Service</a>
        <span>{GLOBAL.email.support}</span>
      </BrandFooter>
    </BrandFrame>
  );
}
