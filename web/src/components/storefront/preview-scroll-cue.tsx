"use client";

import { useSyncExternalStore } from "react";
import { motion, useReducedMotion } from "framer-motion";

export interface PreviewScrollCueProps {
  targetId: string;
  label: string;
  bounceDistancePx: number;
  bounceDurationS: number;
  bounceRepeatDelayS: number;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Keyboard-accessible scroll cue placed at the bottom of the product details card when
 * an interactive page-turn previewer is present. Gently animates the down arrow and
 * smooth-scrolls to the previewer, yielding to prefers-reduced-motion (no bounce,
 * instant scroll).
 */
export function PreviewScrollCue({
  targetId,
  label,
  bounceDistancePx,
  bounceDurationS,
  bounceRepeatDelayS,
}: PreviewScrollCueProps) {
  const framerReduced = useReducedMotion();
  const mediaReduced = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    () => false,
  );
  const reduced = Boolean(framerReduced) || mediaReduced;

  const handleClick = () => {
    const target = document.getElementById(targetId);
    if (!target) return;
    target.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "start",
    });
  };

  return (
    <div className="mt-auto pt-3 border-t border-[#efe4d6] flex justify-start">
      <button
        type="button"
        onClick={handleClick}
        aria-controls={targetId}
        data-testid="preview-scroll-cue"
        className="group inline-flex items-center gap-2.5 min-h-[44px] rounded-full border border-[#dcc7b4] bg-white/85 hover:bg-[#fff2e4] px-4 py-2 text-sm font-semibold text-gray-900 transition-colors cursor-pointer focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#E8622C]"
      >
        <span>{label}</span>
        <motion.span
          aria-hidden="true"
          data-testid="preview-scroll-cue-arrow"
          className="inline-flex items-center justify-center text-[#b3401e]"
          initial={{ y: 0 }}
          animate={reduced ? { y: 0 } : { y: [0, bounceDistancePx, 0] }}
          transition={
            reduced
              ? { duration: 0 }
              : {
                  duration: bounceDurationS,
                  repeat: Infinity,
                  repeatDelay: bounceRepeatDelayS,
                  ease: "easeInOut",
                }
          }
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.25}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </motion.span>
      </button>
    </div>
  );
}
