import * as Sentry from "@sentry/nextjs";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import { BrandButton, BrandFooter, BrandFrame, BrandWordmark } from "../../../../src/components/brand/brand";
import { getPortalSession } from "../../../../src/lib/supabase-server";
import { resolvePrimaryProduct } from "../../../../src/lib/primary-product";
import { portalConsentState } from "../../../../src/lib/consent-chain";
import { loadCreatorConsentRows } from "../../../../src/lib/creator-consents";
import { toError } from "../../../../src/lib/error-reporting";

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
// readC3Status's catch swallowed it (logged as a false "C3 status check failed").
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agreement signing · ExpanPress",
  robots: { index: false, follow: false },
};

type C3Status = "recorded" | "pending" | "failed";

async function readC3Status(): Promise<C3Status> {
  try {
    const session = await getPortalSession();
    if (!session) return "pending";
    const { product, error: productError } = await resolvePrimaryProduct<{ id: string; creator_id: string | null; release_sha256: string | null }>(
      session.supabase,
      "id, creator_id, release_sha256",
    );
    if (productError) {
      const error = toError(productError);
      console.error("[esign_done] products query failed:", error.message);
      Sentry.captureException(error, { tags: { surface: "esign_done", query: "products" } });
      return "failed";
    }
    if (!product) return "pending";
    // Same strict chain rule as checkout: a C3 superseded by a later refusal (even one on
    // another product) is not a recorded agreement. Only the C3 chain is read; the rule is per kind.
    const { rows, error: consentsError } = await loadCreatorConsentRows(session.supabase, product.creator_id, {
      kinds: ["C3_revenue_split"],
    });
    if (consentsError) {
      const error = toError(consentsError);
      console.error("[esign_done] consents query failed:", error.message);
      Sentry.captureException(error, { tags: { surface: "esign_done", query: "consents" } });
      return "failed";
    }
    return portalConsentState(rows, product.id, product.release_sha256).hasC3 ? "recorded" : "pending";
  } catch (err) {
    const error = toError(err);
    console.error("[esign_done] C3 status check failed:", error);
    Sentry.captureException(error, { tags: { surface: "esign_done", query: "c3" } });
    return "failed";
  }
}

export default async function EsignDonePage() {
  const status = await readC3Status();
  const recorded = status === "recorded";
  const failed = status === "failed";
  return (
    <BrandFrame outerClassName="justify-between">
      <header className="flex items-center justify-between">
        <BrandWordmark href="/creator/dashboard" label="Creator dashboard" />
      </header>
      <main className="mx-auto w-full max-w-[640px]">
        <div className="neu-card rounded-[32px] p-6 sm:p-8 text-center">
          <p
            className={`text-[40px] leading-none ${failed ? "text-[#8A4B2D]" : "text-[#2E7D5B]"}`}
            aria-hidden
          >
            {recorded ? "✓" : failed ? "!" : "…"}
          </p>
          <h1 className="mt-3 text-2xl sm:text-3xl font-bold tracking-tight text-gray-900">
            {recorded
              ? "Revenue-split agreement signed"
              : failed
                ? "We couldn't verify your signature status"
                : "Finalising your signature"}
          </h1>
          {failed ? (
            <p className="mt-3 text-base text-[#8A4B2D]" role="alert">
              This looks like a temporary problem on our side — please reload this page in a moment to check again, or return to your dashboard.
            </p>
          ) : (
            <>
              <p className="mt-3 text-base text-gray-700">
                {recorded
                  ? "Thank you — your signature and the completion certificate have been recorded."
                  : "Thank you — we're confirming your signature with the signing service. This usually takes under a minute; your dashboard shows it as signed once it's recorded."}
              </p>
              <p className="mt-2 text-base text-gray-700">
                A copy of the signed agreement and its audit-trail certificate will arrive in your inbox within a few minutes. Keep both for your records.
              </p>
            </>
          )}
          <BrandButton href="/creator/dashboard" className="mt-6 mx-auto">
            Back to your dashboard
          </BrandButton>
          <p className="mt-6 border-t border-[#dcc7b4] pt-4 text-left text-sm text-gray-600">
            <b className="text-gray-900">Confidentiality.</b> This agreement contains confidential commercial and financial terms. Please keep it private.
          </p>
        </div>
      </main>
      <BrandFooter>
        <a href="/privacy.html" className="hover:text-gray-700 transition-colors">Privacy Policy</a>
        <a href="/terms.html" className="hover:text-gray-700 transition-colors">Terms of Service</a>
        <span>{GLOBAL.email.support}</span>
      </BrandFooter>
    </BrandFrame>
  );
}
