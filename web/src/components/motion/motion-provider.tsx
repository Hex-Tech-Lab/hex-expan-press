"use client";

import { LazyMotion } from "framer-motion";

const loadDomAnimation = () => import("./dom-animation-features").then((mod) => mod.default);

/**
 * LazyMotion boundary for the creator funnel (Wave 8.2). Children render `m.*`
 * (not `motion.*`); the domAnimation feature bundle (animate / exit / variants /
 * whileTap / whileHover) is fetched AFTER hydration via dynamic import, so it is
 * not part of the route's first-load JS. Not `strict`: a stray full `motion.*`
 * (e.g. from a nested or third-party component) still renders instead of throwing
 * at runtime — it just ships the full engine for that component.
 */
export default function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={loadDomAnimation}>
      {children}
    </LazyMotion>
  );
}
