"use client";

/**
 * Creator dashboard — client surface (Wave 4).
 *
 * Data arrives fully hydrated from the RSC (profile, review progress, consent
 * states, journey step) — there is no client-side fetching here. Visuals
 * follow the Wave 3.4 system: NEMA bevels, peach highlights, 320/12 paper
 * wobble on press, staggered spring entrance. Icons come from Iconify
 * (Lucide set, registered offline after hydration to keep the main bundle
 * lean per the bundle-size rules). Spacing/typography consume the Astryx
 * neutral theme tokens injected by the dashboard layout.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Icon, addCollection } from "@iconify/react";
import JourneyDots from "../../../src/components/journey/journey-dots";
import SignOutButton from "./sign-out-button";
import { startPublisherAgreementAction } from "./actions";

const EASE = [0.16, 1, 0.3, 1] as const;
/* NOTE: `.neu-card` in globals.css carries the same bevel stack; when an
   element animates boxShadow inline (TiltCard), the inline value must include
   the inset pair or the bevel disappears during the animation. */
const WOBBLE = { type: "spring" as const, stiffness: 320, damping: 12 };

export interface DashboardClientProps {
  name: string;
  email: string;
  answersCount: number;
  answersTarget: number;
  hasC1: boolean;
  hasC2: boolean;
  hasC3: boolean;
  journeyActive: number;
  /** Dashboard ?error= param from a failed Step 3 Server Action redirect. */
  actionError?: "credits" | "esign" | "no_product";
}

const ACTION_ERROR_COPY: Record<NonNullable<DashboardClientProps["actionError"]>, string> = {
  credits: "The signing service is awaiting credit activation — please try again shortly.",
  esign: "Something went wrong starting your agreement — please try again.",
  no_product: "No product is linked to your account yet — contact support@expanpress.com.",
};

const JOURNEY_LABELS = ["Bio & Content", "Legal & Assets", "Revenue & Publish"];

interface StepCard {
  num: string;
  title: string;
  desc: string;
  href: string;
  status: string;
  done: boolean;
  icon: string;
  cta: string;
}

export default function DashboardClient({
  name,
  email,
  answersCount,
  answersTarget,
  hasC1,
  hasC2,
  hasC3,
  journeyActive,
  actionError,
}: DashboardClientProps) {
  const [iconsReady, setIconsReady] = useState(false);
  const reduced = useReducedMotion();

  // Lucide set loads in an async chunk — keeps ~1MB of icon data out of the
  // main bundle (bundle-* rules); icons resolve right after hydration.
  useEffect(() => {
    let mounted = true;
    void import("@iconify-json/lucide/icons.json").then((m) => {
      const data = (m as { default?: object }).default ?? (m as object);
      addCollection(data as Parameters<typeof addCollection>[0]);
      if (mounted) setIconsReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const step1Done = answersCount >= answersTarget;
  const step1Status =
    step1Done
      ? `Completed (${answersCount} of ${answersTarget})`
      : answersCount > 0
        ? `In Progress (${answersCount} of ${answersTarget})`
        : "Interactive Reader";
  const step2Done = hasC1 && hasC2;
  const step3Done = hasC3;

  const steps: StepCard[] = [
    {
      num: "Step 1",
      title: "Manuscript & Quote Review",
      desc: "Review quotes, confirm facts, and verify figures in your manuscript draft with the interactive page-flip reader.",
      href: "/creator/review/",
      status: step1Status,
      done: step1Done,
      icon: "lucide:book-open",
      cta: "Open review stepper →",
    },
    {
      num: "Step 2",
      title: "Accuracy & Release Consents (C1 & C2)",
      desc: "Confirm factual accuracy of your answers (C1) and sign release approval for publication of the completed book (C2).",
      href: "/creator/consents/",
      status: step2Done ? "Completed & Signed" : "Legal Consents",
      done: step2Done,
      icon: hasC2 ? "lucide:check-circle" : "lucide:lock",
      cta: step2Done ? "Consents on file ✓" : "Sign consents →",
    },
    {
      num: "Step 3",
      title: "Publisher Agreement (C3)",
      desc: "Review and electronically sign the author agreement and distribution terms with automated audit trail via Firma.",
      href: "/creator/consents/",
      status: step3Done ? "Executed" : "Publishing Terms",
      done: step3Done,
      icon: hasC3 ? "lucide:check-circle" : "lucide:file-signature",
      cta: step3Done ? "Agreement Executed ✓" : "Review & sign agreement →",
    },
  ];

  return (
    <div className="mx-auto max-w-[680px] px-5 pb-16 pt-12">
      <motion.p
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } }}
        className="mb-3 text-[length:var(--font-size-xs)] font-semibold uppercase tracking-[0.14em] text-[#B3401E]"
      >
        Creator Portal
      </motion.p>
      <motion.h1
        initial={{ opacity: 0, y: 28 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.06 } }}
        className="font-serif text-[length:var(--text-heading-1-size)] font-bold leading-[1.15] tracking-[-0.015em] text-[#2B2520]"
      >
        Your creator dashboard
      </motion.h1>

      {/* Publication status badge */}
      <motion.div
        initial={{ opacity: 0, y: 28 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.12 } }}
        className="mt-5 mb-6 inline-flex items-center gap-2 rounded-full border border-[#EADFD1] bg-[#F3ECDF] px-3 py-1.5 text-[length:var(--font-size-xs)] font-semibold text-[#6E5F53]"
        role="status"
      >
        <motion.span
          aria-hidden
          className="h-2 w-2 rounded-full"
          style={{ background: hasC3 ? "#2E7D5B" : "#E8622C" }}
          animate={{ scale: [1, 1.3, 1], opacity: [1, 0.7, 1] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
        />
        <span>{hasC3 ? "Publication Status: Agreement Signed — Ready for Release" : "Publication Status: Pending Review & Release"}</span>
      </motion.div>

      {/* Account card */}
      <motion.section
        initial={{ opacity: 0, y: 32 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.18 } }}
        className="neu-card mb-5 rounded-[14px] p-(--space-5)"
        aria-label="Account"
      >
        <p className="text-[length:var(--font-size-base)] text-[#2B2520]">
          Signed in as <b className="font-semibold">{name}</b>
        </p>
        <p className="mt-1 mb-4 text-[length:var(--font-size-sm)] text-[#6E5F53]">{email}</p>
        <SignOutButton iconsReady={iconsReady} />
      </motion.section>

      {/* Journey tracker — the creator's live status bar (Wave 4) */}
      <motion.section
        initial={{ opacity: 0, y: 32 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.24 } }}
        className="neu-card mb-7 rounded-[14px] p-(--space-5)"
        aria-label="Your journey"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[length:var(--font-size-2xs)] font-bold uppercase tracking-[0.08em] text-[#B3401E]">Your journey</p>
            <p className="mt-0.5 text-[length:var(--font-size-sm)] font-medium text-[#6E5F53]">
              {JOURNEY_LABELS[journeyActive]} — you are here
            </p>
          </div>
          <JourneyDots active={journeyActive} reduced={Boolean(reduced)} className="shrink-0" />
        </div>
      </motion.section>

      <motion.h2
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: 0.4, ease: EASE, delay: 0.3 } }}
        className="mb-4 mt-7 font-serif text-[length:var(--text-heading-2-size)] font-bold text-[#2B2520]"
      >
        Required Release Steps
      </motion.h2>

      {/* Staggered spring entrance for the step cards (Wave 4 mandate).
          Pending Step 3 (Wave 6) renders as a Server-Action form — the card
          is the submit button (320/12 paper wobble on press); the consents
          page stays reachable as a secondary "review documents" link, since
          a link cannot live inside a button. */}
      {actionError && (
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } }}
          className="mb-3.5 rounded-xl border border-[#EADFD1] bg-[#F3ECDF] p-(--space-4) text-[length:var(--font-size-sm)] font-medium text-[#8A4B2D]"
          role="alert"
        >
          {ACTION_ERROR_COPY[actionError]}
        </motion.p>
      )}
      <AnimatePresence>
        {steps.map((step, i) => {
          const body = (
            <>
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-[length:var(--font-size-2xs)] font-bold uppercase tracking-[0.08em] text-[#B3401E]">
                  {step.num}
                </span>
                <span
                  className="inline-flex items-center gap-1.5 text-[length:var(--font-size-2xs)] font-semibold"
                  style={{ color: step.done ? "#2E7D5B" : "#6E5F53" }}
                >
                  {iconsReady && (
                    <Icon icon={step.done ? "lucide:check-circle" : step.icon} width={14} height={14} aria-hidden />
                  )}
                  {step.status}
                </span>
              </div>
              <p className="font-serif text-[length:var(--text-heading-3-size)] font-bold text-[#2B2520]">{step.title}</p>
              <p className="mt-1 text-[length:var(--font-size-sm)] leading-relaxed text-[#6E5F53]">{step.desc}</p>
              <p className="mt-2 inline-flex items-center gap-1 text-[length:var(--font-size-sm)] font-semibold text-[#296E50]">
                {step.cta}
              </p>
            </>
          );

          if (i === 2 && !step.done) {
            return (
              <motion.form
                key={step.num}
                action={startPublisherAgreementAction}
                initial={{ opacity: 0, y: 40, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5, ease: EASE, delay: 0.34 + i * 0.09 }}
                className="neu-card mb-3.5 block rounded-xl p-(--space-5) transition-shadow hover:shadow-[0_4px_12px_rgba(43,37,32,0.05)]"
              >
                <motion.button
                  type="submit"
                  whileTap={{ scale: 1.01, transition: WOBBLE }}
                  className="block w-full text-left"
                >
                  {body}
                </motion.button>
                <a
                  href={step.href}
                  className="mt-2 inline-flex items-center gap-1 text-[length:var(--font-size-sm)] text-[#6E5F53] no-underline hover:underline"
                >
                  Review documents first →
                </a>
              </motion.form>
            );
          }

          return (
            <motion.a
              key={step.num}
              href={step.done && i === 2 ? undefined : step.href}
              initial={{ opacity: 0, y: 40, scale: 0.97 }}
              animate={{ opacity: step3Done && i === 2 ? 0.85 : 1, y: 0, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5, ease: EASE, delay: 0.34 + i * 0.09 }}
              whileTap={{ scale: 1.01, transition: WOBBLE }}
              aria-disabled={step.done && i === 2}
              className={`neu-card mb-3.5 block rounded-xl p-(--space-5) no-underline text-inherit transition-shadow ${
                step.done ? "hover:shadow-none" : "hover:shadow-[0_4px_12px_rgba(43,37,32,0.05)]"
              } ${step.done && i === 2 ? "cursor-default" : ""}`}
            >
              {body}
            </motion.a>
          );
        })}
      </AnimatePresence>

      <footer className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[#EADFD1] pt-5 text-[length:var(--font-size-sm)] text-[#6E5F53]">
        <a href="/privacy.html" className="text-[#296E50] no-underline hover:underline">Privacy Policy</a>
        <a href="/terms.html" className="text-[#296E50] no-underline hover:underline">Terms of Service</a>
        <span>
          Support: <a href="mailto:support@expanpress.com" className="text-[#296E50] hover:underline">support@expanpress.com</a>
        </span>
      </footer>
    </div>
  );
}
