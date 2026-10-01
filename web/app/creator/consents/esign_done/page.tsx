import Link from "next/link";
import { getPortalSession } from "../../../../src/lib/supabase-server";
import { resolvePrimaryProduct } from "../../../../src/lib/primary-product";

/**
 * Post-signing return page (Wave 6.1, RSC): Firma redirects the creator
 * here after the publisher agreement is signed (create_esign_envelope
 * configures `${hostUrl}/creator/consents/esign_done`). Ported verbatim
 * from the legacy static esign_done.html so the configured return URL
 * resolves to a real route instead of a rewrite.
 *
 * The return URL is NOT proof of signing (anyone can open it, and the browser
 * can arrive before Firma's webhook lands). Completion is claimed only when the
 * C3 consent row exists for the creator's product; otherwise the page says the
 * signature is being finalised.
 */
// Explicitly dynamic: the page reads the session cookie. Without this, Next tries a
// static render at build, cookies() throws its dynamic-bailout signal, and
// hasRecordedC3's catch swallowed it (logged as a false "C3 status check failed").
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agreement signing · ExpanPress",
  robots: { index: false, follow: false },
};

async function hasRecordedC3(): Promise<boolean> {
  try {
    const session = await getPortalSession();
    if (!session) return false;
    const { product, error: productError } = await resolvePrimaryProduct<{ id: string }>(
      session.supabase,
      "id",
    );
    const productId = product?.id;
    if (productError || !productId) return false;
    const { data } = await session.supabase
      .from("consents").select("kind")
      .eq("product_id", productId).eq("kind", "C3_revenue_split").eq("decision", "given").limit(1);
    return (data?.length ?? 0) > 0;
  } catch (err) {
    console.error("[esign_done] C3 status check failed:", err);
    return false;
  }
}

export default async function EsignDonePage() {
  const recorded = await hasRecordedC3();
  return (
    <div className="mx-auto max-w-[640px] px-5 py-20">
      <div className="neu-card rounded-[14px] p-(--space-6) text-center">
        <p className="text-[40px] leading-none text-[#2E7D5B]" aria-hidden>
          {recorded ? "✓" : "…"}
        </p>
        <h1 className="mt-3 font-serif text-[length:var(--text-heading-1-size)] font-bold text-[#2B2520]">
          {recorded ? "Revenue-split agreement signed" : "Finalising your signature"}
        </h1>
        <p className="mt-3 text-[length:var(--font-size-base)] text-[#4A4136]">
          {recorded
            ? "Thank you — your signature and the completion certificate have been recorded."
            : "Thank you — we're confirming your signature with the signing service. This usually takes under a minute; your dashboard shows it as signed once it's recorded."}
        </p>
        <p className="mt-2 text-[length:var(--font-size-base)] text-[#4A4136]">
          A copy of the signed agreement and its audit-trail certificate will arrive in your inbox within a few minutes. Keep both for your records.
        </p>
        <Link
          href="/creator/dashboard"
          className="mt-5 inline-flex min-h-11 items-center rounded-[10px] bg-[#2B2520] px-6 text-[length:var(--font-size-base)] font-semibold text-[#FAF7F2] no-underline transition-colors hover:bg-[#3d352d]"
        >
          Back to your dashboard
        </Link>
        <p className="mt-6 border-t border-[#EADFD1] pt-4 text-left text-[length:var(--font-size-sm)] text-[#6E5F53]">
          <b>Confidentiality.</b> This agreement contains confidential commercial and financial terms. Please keep it private.
        </p>
      </div>
    </div>
  );
}
