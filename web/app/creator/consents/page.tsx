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

  // Chain-head resolution (sprint 12 B2, AGY audit P1, sprint 14 Track C1):
  // fetch decisions for the creator scoped strictly to this product with deterministic order and bound.
  // DEF-005: replace single-page .limit(500) lockout with bounded pagination up to 5,000 rows.
  type ConsentPageRow = {
    id: string;
    kind: string;
    decision: string;
    product_id?: string | null;
    supersedes?: string | null;
  };
  const PAGE_SIZE = 500;
  const SAFETY_CAP = 5000;
  const allConsents: ConsentPageRow[] = [];
  let offset = 0;
  let consentsError: unknown = null;

  while (offset < SAFETY_CAP) {
    const { data, error } = (await supabase
      .from("consents")
      .select("id, kind, decision, product_id, supersedes")
      .eq("product_id", product.id)
      .order("signed_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)) as { data: ConsentPageRow[] | null; error: unknown };

    if (error || !data) {
      consentsError = error ?? new Error("Missing consent data");
      break;
    }

    allConsents.push(...data);
    if (data.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
  }

  if (consentsError || allConsents.length >= SAFETY_CAP) {
    return (
      <ConsentNotice
        title="We couldn't load your consent states."
        body="Please reload in a moment — your progress is safe."
      />
    );
  }
  const active = activeConsentKinds(allConsents, product.id);

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
