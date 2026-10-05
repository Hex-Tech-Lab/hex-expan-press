import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getPortalSession } from "../../../src/lib/supabase-server";
import { resolvePrimaryProduct } from "../../../src/lib/primary-product";
import { activeConsentKinds } from "../../../src/lib/consent-chain";
import ConsentCards from "./consent-cards";

export const metadata: Metadata = {
  title: "Legal Consents · ExpanPress",
  robots: { index: false, follow: false }, // authenticated surface
};

/**
 * Legal consents (Wave 6.1, RSC — replaces the orphaned legacy static page).
 * Session = ssr HttpOnly cookie, fail-closed server redirect. Reads run
 * under the caller's RLS identity: their product and their given consents
 * (C1 data accuracy, C2 release approval; C3 lands via the Firma webhook).
 */
export default async function ConsentsPage() {
  const session = await getPortalSession();
  if (!session) {
    redirect("/creator/signin");
  }
  const { supabase } = session;

  // Product first, then ITS consents: a creator with several products must never
  // see one book's consent as another's (same product resolution as the action).
  const productRes = await resolvePrimaryProduct<{ id: string; title: string }>(supabase, "id, title");
  const product = productRes.product;
  if (productRes.error || !product) {
    return (
      <ConsentNotice
        title="We couldn't load your consents."
        body="This looks like a temporary problem on our side — please reload in a moment, or contact support@expanpress.com."
      />
    );
  }

  // Chain-head resolution (sprint 12 B2, AGY audit P1): fetch ALL decisions
  // for the product (not just "given") — a superseded or superseded-by-refusal
  // row must never display as "Signed ✓". Mirrors the action/bake semantics.
  const consentsRes = await supabase
    .from("consents")
    .select("id, kind, decision, supersedes")
    .eq("product_id", product.id);
  if (consentsRes.error) {
    return (
      <ConsentNotice
        title="We couldn't load your consent states."
        body="Please reload in a moment — your progress is safe."
      />
    );
  }
  const active = activeConsentKinds(consentsRes.data ?? []);

  return (
    <ConsentCards
      bookTitle={product.title}
      hasC1={active.has("C1_data_accuracy")}
      hasC2={active.has("C2_release_approval")}
      hasC3={active.has("C3_revenue_split")}
    />
  );
}

function ConsentNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-[680px] px-5 py-16" role="alert">
      <h1 className="font-serif text-[length:var(--text-heading-1-size)] font-bold text-[#2B2520]">{title}</h1>
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
