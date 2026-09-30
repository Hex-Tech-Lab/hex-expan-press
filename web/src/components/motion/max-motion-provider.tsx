"use client";

import { LazyMotion } from "framer-motion";

const loadDomMax = () => import("./dom-max-features").then((mod) => mod.default);

/**
 * LazyMotion boundary for the landing page: domMax (adds layout animations +
 * drag — the card-expand interaction), loaded on demand. Kept in its own file so
 * the creator funnel never bundles domMax.
 */
export default function MaxMotionProvider({ children }: { children: React.ReactNode }) {
  return <LazyMotion features={loadDomMax}>{children}</LazyMotion>;
}
