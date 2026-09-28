import Link from "next/link";

/**
 * Post-signing return page (Wave 6.1, RSC): Firma redirects the creator
 * here after the publisher agreement is signed (create_esign_envelope
 * configures `${hostUrl}/creator/consents/esign_done`). Ported verbatim
 * from the legacy static esign_done.html so the configured return URL
 * resolves to a real route instead of a rewrite. No auth gate: the
 * creator's browser carries portal cookies and this page renders no data.
 */
export const metadata = {
  title: "Agreement signed · ExpanPress",
  robots: { index: false, follow: false },
};

export default function EsignDonePage() {
  return (
    <div className="mx-auto max-w-[640px] px-5 py-20">
      <div className="neu-card rounded-[14px] p-(--space-6) text-center">
        <p className="text-[40px] leading-none text-[#2E7D5B]" aria-hidden>
          ✓
        </p>
        <h1 className="mt-3 font-serif text-[length:var(--text-heading-1-size)] font-bold text-[#2B2520]">Revenue-split agreement signed</h1>
        <p className="mt-3 text-[length:var(--font-size-base)] text-[#4A4136]">
          Thank you — your signature and the completion certificate have been recorded.
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
