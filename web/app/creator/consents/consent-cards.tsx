"use client";

/**
 * Consent cards client (Wave 6.1, unified with BrandFrame/BrandButton/BrandField).
 * C1/C2 sign through the signConsentAction Server Action (ssr session, RLS RPC);
 * the C3 publisher agreement reuses startPublisherAgreementAction from the dashboard.
 */
import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { AnimatePresence, m } from "framer-motion";
import { BrandButton, BrandField, BrandFooter, BrandFrame, BrandWordmark } from "../../../src/components/brand/brand";
import { signConsentAction, type ConsentFormState } from "./actions";
import { startPublisherAgreementAction } from "../dashboard/actions";

const EASE = [0.16, 1, 0.3, 1] as const;
const EMPTY: ConsentFormState = {};

export interface ConsentCardsProps {
  bookTitle: string;
  hasC1: boolean;
  hasC2: boolean;
  hasC3: boolean;
  supportEmail?: string;
}

function LegalIncorporationClause() {
  return (
    <>
      This agreement incorporates by reference the ExpanPress Terms of Service and Privacy Policy available at{" "}
      <a href="/terms.html" target="_blank" rel="noopener noreferrer" className="underline text-[#296E50] hover:text-gray-900">
        expanpress.com/terms.html
        <span className="sr-only"> (opens in a new tab)</span>
      </a>{" "}
      and{" "}
      <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="underline text-[#296E50] hover:text-gray-900">
        expanpress.com/privacy.html
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      .
    </>
  );
}

/** Submit button that disables itself while its form's action is pending (resets on error). */
function SubmitButton({ idle, busy, className = "" }: { idle: string; busy: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <BrandButton type="submit" disabled={pending} className={`min-h-11 ${className}`.trim()}>
      {pending ? busy : idle}
    </BrandButton>
  );
}

function ConsentFormCard({
  kindValue,
  label,
  heading,
  legal,
  done,
  state,
  formAction,
}: {
  kindValue: string;
  label: string;
  heading: string;
  legal: React.ReactNode;
  done: boolean;
  state: ConsentFormState;
  formAction: (fd: FormData) => void;
}) {
  return (
    <m.section
      initial={{ opacity: 0, y: 32 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } }}
      className="neu-card mb-5 rounded-[32px] p-6 sm:p-8"
      aria-label={heading}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-mono font-bold uppercase tracking-[0.12em] text-[#b3401e]">{label}</span>
        {done && (
          <span className="text-[11px] font-mono font-bold uppercase tracking-[0.12em] text-[#296E50]">Signed ✓</span>
        )}
      </div>
      <h2 className="text-lg font-bold text-gray-900">{heading}</h2>
      <p className="mt-1.5 text-sm sm:text-base leading-relaxed text-gray-700">{legal}</p>

      {done ? (
        <p className="mt-3 text-sm font-medium text-[#296E50]">Consent recorded — thank you.</p>
      ) : (
        <form action={formAction} className="mt-4">
          <input type="hidden" name="kind" value={kindValue} />
          <label htmlFor={`typedName-${kindValue}`} className="block text-sm font-semibold text-gray-900">
            Type your full legal name to sign
          </label>
          <BrandField
            id={`typedName-${kindValue}`}
            name="typedName"
            type="text"
            required
            placeholder="Full legal name"
            className="mt-2"
          />
          {state.error && (
            <p className="mt-2 text-sm font-medium text-[#b3401e]" role="alert">
              {state.error}
            </p>
          )}
          <SubmitButton idle={`Sign ${label}`} busy="Recording…" className="mt-4" />
        </form>
      )}
    </m.section>
  );
}

export default function ConsentCards({ bookTitle, hasC1, hasC2, hasC3, supportEmail }: ConsentCardsProps) {
  const router = useRouter();
  const [c1State, c1Action] = useActionState(signConsentAction, EMPTY);
  const [c2State, c2Action] = useActionState(signConsentAction, EMPTY);

  useEffect(() => {
    if (c1State.ok || c2State.ok) {
      router.refresh();
    }
  }, [c1State.ok, c2State.ok, router]);

  const allLegal = hasC1 && hasC2;

  return (
    <BrandFrame outerClassName="justify-between">
      <header className="flex items-center justify-between">
        <BrandWordmark href="/creator/dashboard" label="Creator dashboard" />
      </header>

      <main className="mx-auto w-full max-w-[680px]">
        <p className="mb-2 text-[11px] sm:text-xs font-mono font-medium uppercase tracking-[0.16em] text-gray-600">
          Creator Portal
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold leading-[1.15] tracking-tight text-gray-900">Final consents</h1>
        <p className="mt-2 mb-6 text-base text-gray-700">
          Review and sign the final approvals to publish <b className="font-semibold">{bookTitle}</b>.
        </p>

        <ConsentFormCard
          kindValue="C1_data_accuracy"
          label="Data Accuracy"
          heading="Data accuracy (C1)"
          legal={
            <>
              I confirm that my answers to the review questions are true and accurate to the best of my knowledge.{" "}
              <LegalIncorporationClause />
            </>
          }
          done={!!hasC1}
          state={c1State}
          formAction={c1Action}
        />

        <ConsentFormCard
          kindValue="C2_release_approval"
          label="Release Approval"
          heading="Release approval (C2)"
          legal={
            <>
              I approve the release of the final PDF for publication.{" "}
              <LegalIncorporationClause />
            </>
          }
          done={!!hasC2}
          state={c2State}
          formAction={c2Action}
        />

        <AnimatePresence>
          {allLegal && (
            <m.section
              key="c3"
              initial={{ opacity: 0, y: 32 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.1 } }}
              className="neu-card mb-5 rounded-[32px] p-6 sm:p-8"
              aria-label="Revenue split agreement"
            >
              <span className="text-[11px] font-mono font-bold uppercase tracking-[0.12em] text-[#b3401e]">
                3. Revenue Split Agreement
              </span>
              <h2 className="mt-2 text-lg font-bold text-gray-900">Publisher agreement (C3)</h2>
              {hasC3 ? (
                <p className="mt-3 text-base font-medium text-[#296E50]">
                  Agreement executed ✓ — your book is cleared for release.
                </p>
              ) : (
                <>
                  <p className="mt-1.5 text-sm sm:text-base leading-relaxed text-gray-700">
                    Sign the revenue split agreement electronically with our e-signature provider, Firma.{" "}
                    <LegalIncorporationClause />
                  </p>
                  <form action={startPublisherAgreementAction} className="mt-4">
                    <SubmitButton idle="Open the agreement →" busy="Opening agreement…" />
                  </form>
                </>
              )}
            </m.section>
          )}
        </AnimatePresence>

        <m.div initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.4, ease: EASE, delay: 0.2 } }} className="mt-7">
          <BrandButton variant="secondary" href="/creator/dashboard" className="min-h-11 px-5 py-2.5">
            ← Back to dashboard
          </BrandButton>
        </m.div>
      </main>

      <BrandFooter>
        <a href="/privacy.html" className="hover:text-gray-700 transition-colors">Privacy Policy</a>
        <a href="/terms.html" className="hover:text-gray-700 transition-colors">Terms of Service</a>
        {supportEmail ? <span>{supportEmail}</span> : null}
      </BrandFooter>
    </BrandFrame>
  );
}
