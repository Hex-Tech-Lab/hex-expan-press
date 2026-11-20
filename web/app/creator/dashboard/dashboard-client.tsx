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
import { useFormStatus } from "react-dom";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Icon, addCollection } from "@iconify/react";
import { BrandFooter, BrandFrame, BrandWordmark } from "../../../src/components/brand/brand";
import JourneyDots from "../../../src/components/journey/journey-dots";
import SignOutButton from "./sign-out-button";
import { startPublisherAgreementAction } from "./actions";

const EASE = [0.16, 1, 0.3, 1] as const;
/* NOTE: `.neu-card` in globals.css carries the same bevel stack; when an
   element animates boxShadow inline (TiltCard), the inline value must include
   the inset pair or the bevel disappears during the animation. */
const WOBBLE = { type: "spring" as const, stiffness: 320, damping: 12 };

function Step3SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <m.button
      type="submit"
      disabled={pending}
      whileTap={{ scale: 1.01, transition: WOBBLE }}
      className="block w-full text-left disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </m.button>
  );
}

export interface DashboardClientProps {
  name: string;
  email: string;
  supportEmail: string;
  answersCount: number;
  answersTarget: number;
  hasC1: boolean;
  hasC2: boolean;
  hasC3: boolean;
  journeyActive: number;
  /** Dashboard ?error= param from a failed Step 3 Server Action redirect. */
  actionError?: "credits" | "esign" | "no_product" | "load_failed";
  c2RequiredBanner?: boolean;
}

function actionErrorCopy(
  code: NonNullable<DashboardClientProps["actionError"]>,
  supportEmail: string,
): string {
  switch (code) {
    case "credits":
      return "The signing service is awaiting credit activation — please try again shortly.";
    case "esign":
      return "Something went wrong starting your agreement — please try again.";
    case "no_product":
      return `No product is linked to your account yet — contact ${supportEmail}.`;
    case "load_failed":
      return "We could not load your agreement status. Please reload. If it keeps happening, contact support.";
  }
}

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
  supportEmail,
  answersCount,
  answersTarget,
  hasC1,
  hasC2,
  hasC3,
  journeyActive,
  actionError,
  c2RequiredBanner,
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

  const step1Done = answersTarget > 0 && answersCount >= answersTarget; // 0 of 0 = nothing assigned, not done
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
    <BrandFrame outerClassName="justify-between">
      <header className="flex items-center justify-between">
        <BrandWordmark href="/" label="ExpanPress home" />
      </header>

      <main className="mx-auto w-full max-w-[680px]">
        {c2RequiredBanner && (
          <p
            className="mb-4 rounded-2xl border border-[#dcc7b4] bg-[#fff2e4]/60 p-4 text-sm font-medium text-[#8A4B2D]"
            role="alert"
          >
            Please approve the release (step 2) before signing the publisher agreement.
          </p>
        )}

        <m.p
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } }}
          className="mb-2 text-[11px] sm:text-xs font-mono font-medium uppercase tracking-[0.16em] text-gray-600"
        >
          Creator Portal
        </m.p>
        <m.h1
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.06 } }}
          className="text-3xl sm:text-4xl font-bold leading-[1.15] tracking-tight text-gray-900"
        >
          Your creator dashboard
        </m.h1>

        {/* Publication status badge */}
        <m.div
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.12 } }}
          className="mt-5 mb-6 inline-flex items-center gap-2 rounded-full border border-[#dcc7b4] bg-white/80 px-3.5 py-1.5 text-xs font-semibold text-gray-700"
          role="status"
        >
          <m.span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ background: hasC3 ? "#2E7D5B" : "#E8622C" }}
            animate={{ scale: [1, 1.3, 1], opacity: [1, 0.7, 1] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
          />
          <span>{hasC3 ? "Publication Status: Agreement Signed — Ready for Release" : "Publication Status: Pending Review & Release"}</span>
        </m.div>

        {/* Account card */}
        <m.section
          initial={{ opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.18 } }}
          className="neu-card mb-5 rounded-[32px] p-6"
          aria-label="Account"
        >
          <p className="text-base text-gray-900">
            Signed in as <b className="font-semibold">{name}</b>
          </p>
          <p className="mt-1 mb-4 text-sm text-gray-600">{email}</p>
          <SignOutButton iconsReady={iconsReady} />
        </m.section>

        {/* Journey tracker — the creator's live status bar (Wave 4) */}
        <m.section
          initial={{ opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.24 } }}
          className="neu-card mb-7 rounded-[32px] p-6"
          aria-label="Your journey"
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[11px] font-mono font-bold uppercase tracking-[0.12em] text-[#b3401e]">Your journey</p>
              <p className="mt-0.5 text-sm font-medium text-gray-700">
                {JOURNEY_LABELS[journeyActive]} — you are here
              </p>
            </div>
            <JourneyDots active={journeyActive} reduced={Boolean(reduced)} className="shrink-0" />
          </div>
        </m.section>

        <m.h2
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.4, ease: EASE, delay: 0.3 } }}
          className="mb-4 mt-7 text-xl sm:text-2xl font-bold tracking-tight text-gray-900"
        >
          Required Release Steps
        </m.h2>

        {/* Staggered spring entrance for the step cards (Wave 4 mandate).
            Pending Step 3 (Wave 6) renders as a Server-Action form — the card
            is the submit button (320/12 paper wobble on press); the consents
            page stays reachable as a secondary "review documents" link, since
            a link cannot live inside a button. */}
        {actionError && (
          <m.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } }}
            className="mb-3.5 rounded-2xl border border-[#dcc7b4] bg-[#fff2e4]/60 p-4 text-sm font-medium text-[#8A4B2D]"
            role="alert"
          >
            {actionErrorCopy(actionError, supportEmail)}
          </m.p>
        )}
        <AnimatePresence>
          {steps.map((step, idx) => {
            const body = (
              <>
                <div className="mb-2.5 flex items-center justify-between">
                  <span className="text-[11px] font-mono font-bold uppercase tracking-[0.12em] text-[#b3401e]">
                    {step.num}
                  </span>
                  <span
                    className="inline-flex items-center gap-1.5 text-xs font-semibold"
                    style={{ color: step.done ? "#2E7D5B" : "#4b5563" }}
                  >
                    {iconsReady && (
                      <Icon icon={step.done ? "lucide:check-circle" : step.icon} width={14} height={14} aria-hidden />
                    )}
                    {step.status}
                  </span>
                </div>
                <p className="text-lg font-bold text-gray-900">{step.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-gray-700">{step.desc}</p>
                <p className="mt-2.5 inline-flex items-center gap-1 text-sm font-semibold text-[#296E50]">
                  {step.cta}
                </p>
              </>
            );

            if (idx === 2 && !step.done) {
              return (
                <m.form
                  key={step.num}
                  action={startPublisherAgreementAction}
                  initial={{ opacity: 0, y: 40, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.5, ease: EASE, delay: 0.34 + idx * 0.09 }}
                  className="neu-card mb-4 block rounded-[32px] p-6 transition-shadow hover:shadow-[0_4px_12px_rgba(43,37,32,0.05)]"
                >
                  <Step3SubmitButton>{body}</Step3SubmitButton>
                  <a
                    href={step.href}
                    className="mt-2 inline-flex items-center gap-1 text-sm text-gray-600 no-underline hover:text-gray-900 hover:underline"
                  >
                    Review documents first →
                  </a>
                </m.form>
              );
            }

            return (
              <m.a
                key={step.num}
                href={step.done && idx === 2 ? undefined : step.href}
                initial={{ opacity: 0, y: 40, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5, ease: EASE, delay: 0.34 + idx * 0.09 }}
                whileTap={{ scale: 1.01, transition: WOBBLE }}
                aria-disabled={step.done && idx === 2}
                className={`neu-card mb-4 block rounded-[32px] p-6 no-underline text-inherit transition-shadow ${
                  step.done ? "hover:shadow-none" : "hover:shadow-[0_4px_12px_rgba(43,37,32,0.05)]"
                } ${step.done && idx === 2 ? "cursor-default" : ""}`}
              >
                {body}
              </m.a>
            );
          })}
        </AnimatePresence>
      </main>

      <BrandFooter>
        <a href="/privacy.html" className="hover:text-gray-700 transition-colors">Privacy Policy</a>
        <a href="/terms.html" className="hover:text-gray-700 transition-colors">Terms of Service</a>
        <a href={`mailto:${supportEmail}`} className="hover:text-gray-700 transition-colors">{supportEmail}</a>
      </BrandFooter>
    </BrandFrame>
  );
}
