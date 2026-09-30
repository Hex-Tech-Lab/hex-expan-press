"use client";

/**
 * Consent cards client (Wave 6.1). C1/C2 sign through the signConsentAction
 * Server Action (ssr session, RLS RPC); the C3 publisher agreement reuses
 * startPublisherAgreementAction from the dashboard (single source — it
 * creates the Firma envelope and redirects to the signing flow). The
 * "Back to Dashboard" nav is a Next <Link> with a soft Framer Motion hover.
 */
import { useActionState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { signConsentAction, type ConsentFormState } from "./actions";
import { startPublisherAgreementAction } from "../dashboard/actions";

const EASE = [0.16, 1, 0.3, 1] as const;
const EMPTY: ConsentFormState = {};

export interface ConsentCardsProps {
  bookTitle: string;
  hasC1: boolean;
  hasC2: boolean;
  hasC3: boolean;
}

function ConsentFormCard({
  kindValue,
  label,
  heading,
  legal,
  done,
  state,
  formAction,
  pending,
}: {
  kindValue: string;
  label: string;
  heading: string;
  legal: string;
  done: boolean;
  state: ConsentFormState;
  formAction: (fd: FormData) => void;
  pending: boolean;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 32 }}
      // Completed cards stay at full opacity: dimming the whole card (was 0.85) pulled the
      // AA text tokens back under 4.5:1. The "Signed" badge carries the completed state.
      animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } }}
      className="neu-card mb-5 rounded-[14px] p-(--space-5)"
      aria-label={heading}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[length:var(--font-size-2xs)] font-bold uppercase tracking-[0.08em] text-[#B3401E]">{label}</span>
        {done && (
          <span className="text-[length:var(--font-size-2xs)] font-bold uppercase tracking-[0.08em] text-[#296E50]">Signed ✓</span>
        )}
      </div>
      <h2 className="font-serif text-[length:var(--text-heading-3-size)] font-bold text-[#2B2520]">{heading}</h2>
      <p className="mt-1.5 text-[length:var(--font-size-base)] leading-relaxed text-[#4A4136]">{legal}</p>

      {done ? (
        <p className="mt-3 text-[length:var(--font-size-sm)] font-medium text-[#296E50]">Consent recorded — thank you.</p>
      ) : (
        <form action={formAction} className="mt-3">
          <input type="hidden" name="kind" value={kindValue} />
          <label htmlFor={`typedName-${kindValue}`} className="block text-[length:var(--font-size-sm)] font-semibold text-[#2B2520]">
            Type your full legal name to sign
          </label>
          <input
            id={`typedName-${kindValue}`}
            name="typedName"
            type="text"
            required
            placeholder="e.g. Duane Smith"
            className="mt-2 w-full rounded-lg border border-[#EADFD1] bg-[#FFFDF9] p-3 text-[length:var(--font-size-base)] text-[#2B2520] outline-none focus:border-[#E8622C] focus-visible:ring-2 focus-visible:ring-[#B3401E] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FFFDF9]"
          />
          {state.error && (
            <p className="mt-2 text-[length:var(--font-size-sm)] font-medium text-[#B3401E]" role="alert">
              {state.error}
            </p>
          )}
          <motion.button
            type="submit"
            disabled={pending}
            whileTap={{ scale: 1.015, transition: { type: "spring", stiffness: 320, damping: 12 } }}
            className="mt-3 min-h-11 rounded-[10px] bg-[#2B2520] px-6 text-[length:var(--font-size-sm)] font-semibold text-[#FAF7F2] transition-colors hover:bg-[#3d352d] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Recording…" : `Sign ${label}`}
          </motion.button>
        </form>
      )}
    </motion.section>
  );
}

export default function ConsentCards({ bookTitle, hasC1, hasC2, hasC3 }: ConsentCardsProps) {
  const [c1State, c1Action, c1Pending] = useActionState(signConsentAction, EMPTY);
  const [c2State, c2Action, c2Pending] = useActionState(signConsentAction, EMPTY);
  const c1Done = hasC1 || c1State.ok;
  const c2Done = hasC2 || c2State.ok;
  const allLegal = c1Done && c2Done;

  return (
    <div className="mx-auto max-w-[680px] px-5 pb-16 pt-10">
      <p className="mb-1 text-[length:var(--font-size-xs)] font-semibold uppercase tracking-[0.14em] text-[#B3401E]">Creator Portal</p>
      <h1 className="font-serif text-[length:var(--text-heading-1-size)] font-bold leading-[1.15] text-[#2B2520]">Final consents</h1>
      <p className="mt-1 mb-6 text-[length:var(--font-size-base)] text-[#6E5F53]">
        Review and sign the final approvals to publish <b className="font-semibold">{bookTitle}</b>.
      </p>

      <ConsentFormCard
        kindValue="C1_data_accuracy"
        label="Data Accuracy"
        heading="Data accuracy (C1)"
        legal="I confirm that my answers to the review questions are true and accurate to the best of my knowledge."
        done={!!c1Done}
        state={c1State}
        formAction={c1Action}
        pending={c1Pending}
      />

      <ConsentFormCard
        kindValue="C2_release_approval"
        label="Release Approval"
        heading="Release approval (C2)"
        legal="I approve the release of the final PDF for publication."
        done={!!c2Done}
        state={c2State}
        formAction={c2Action}
        pending={c2Pending}
      />

      <AnimatePresence>
        {allLegal && (
          <motion.section
            key="c3"
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.1 } }}
            className="neu-card mb-5 rounded-[14px] p-(--space-5)"
            aria-label="Revenue split agreement"
          >
            <span className="text-[length:var(--font-size-2xs)] font-bold uppercase tracking-[0.08em] text-[#B3401E]">3. Revenue Split Agreement</span>
            <h2 className="mt-2 font-serif text-[length:var(--text-heading-3-size)] font-bold text-[#2B2520]">Publisher agreement (C3)</h2>
            {hasC3 ? (
              <p className="mt-3 text-[length:var(--font-size-base)] font-medium text-[#296E50]">Agreement executed ✓ — your book is cleared for release.</p>
            ) : (
              <>
                <p className="mt-1.5 text-[length:var(--font-size-base)] leading-relaxed text-[#4A4136]">
                  Sign the revenue split agreement electronically — a signed copy and its audit-trail certificate are emailed to you afterwards.
                </p>
                <form action={startPublisherAgreementAction} className="mt-3">
                  <motion.button
                    type="submit"
                    whileTap={{ scale: 1.015, transition: { type: "spring", stiffness: 320, damping: 12 } }}
                    className="min-h-11 rounded-[10px] bg-[#2B2520] px-6 text-[length:var(--font-size-sm)] font-semibold text-[#FAF7F2] transition-colors hover:bg-[#3d352d]"
                  >
                    Open the agreement →
                  </motion.button>
                </form>
              </>
            )}
          </motion.section>
        )}
      </AnimatePresence>

      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.4, ease: EASE, delay: 0.2 } }} className="mt-7">
        <motion.div whileHover={{ y: -2, transition: { duration: 0.2, ease: "easeOut" } }} className="inline-block">
          <Link
            href="/creator/dashboard"
            className="inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-[#EADFD1] bg-[#FFFDF9] px-5 text-[length:var(--font-size-sm)] font-semibold text-[#6E5F53] no-underline shadow-[0_1px_3px_rgba(43,37,32,0.04)] transition-colors hover:bg-[#F3ECDF] hover:text-[#2B2520]"
          >
            ← Back to dashboard
          </Link>
        </motion.div>
      </motion.div>
    </div>
  );
}
