"use client";

/**
 * Wave 3 landing — construction-based motion system.
 *
 * Founder motion contract (2026-09-28): the page must be ALIVE — built by
 * motion, not decorated with it. Entrance assembles the layout with a beat;
 * idle elements keep moving; bento cards are pointer-3D with shading; clicking
 * a card splits the page (card expands via layout animation, the rest compress
 * into a rail, a detail slide inserts in the freed area, close reverses).
 * Everything yields to prefers-reduced-motion and coarse pointers.
 */

import {
  AnimatePresence,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type Variants,
} from "framer-motion";
import Link from "next/link";
import { useRef, useState, useSyncExternalStore } from "react";

/** True only when the device has a fine pointer (hover-capable mouse) — tilt
 * is disabled on touch devices and during SSR via the server snapshot. */
function subscribeFinePointer(onChange: () => void) {
  const mq = window.matchMedia("(pointer: fine)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
function useFinePointer(): boolean {
  return useSyncExternalStore(
    subscribeFinePointer,
    () => window.matchMedia("(pointer: fine)").matches,
    () => false,
  );
}

const SIGNIN = "/creator/signin/";

/* ---------------------------------------------------------------- tokens */

/* Motion physics — Wave 3.1 founder spec: heavy, deliberate, premium.
   No bouncy springs anywhere: layout/orchestration use high-damping springs,
   fades and micro-interactions use the settle bezier at 0.6s. */
const HEAVY = { type: "spring" as const, stiffness: 100, damping: 25, mass: 1 };
const APPLE = { duration: 0.5, ease: [0.32, 0.72, 0, 1] as const }; // swift-out layout easing
const EASE = [0.16, 1, 0.3, 1] as const;
const settle = (duration = 0.6, delay = 0) => ({ duration, ease: EASE, delay });
const BEAT = 0.09; // seconds between staggered constructions — the page's pulse
/* Shared soft shadow ladder (extremely wide, barely-there opacity). */
const SHADOW_LIFT = "0 32px 72px rgba(0,0,0,0.05), 0 2px 6px rgba(0,0,0,0.02)";

/* ----------------------------------------------------------------- icons */

const ArrowIcon = ({ className = "w-3.5 h-3.5" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

const DockIcon = ({ d }: { d: string }) => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const DOCK_ITEMS = [
  { href: SIGNIN, title: "Creator Sign In", d: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" },
  { href: "#voice", title: "Your Audience", d: "M3 11l18-5v12L3 14v-3z M11.6 16.8a3 3 0 1 1-5.8-1.6" },
  { href: "#how-it-works", title: "How It Works", d: "M12 5v3M12 16v3M8.5 8.5l2 2M13.5 13.5l2 2M5 12h3M16 12h3M8.5 15.5l2-2M13.5 10.5l2-2" },
  { href: "#spotlight", title: "Notifications", d: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0" },
];

/* ------------------------------------------------------------ detail data */

const DETAILS: { steps: string[] }[] = [
  { steps: ["Ingest your videos", "Extract your voiceprint", "Draft in your cadence"] },
  { steps: ["You talk, we listen", "We assemble the manuscript", "You approve and sign"] },
  { steps: ["Release ships", "Storefront goes live", "Payouts run themselves"] },
  { steps: ["Author review", "Signed and watermarked", "Published under your name"] },
];

/* ------------------------------------------- variant factories (altitude) */

function riseVariants(reduced: boolean | null): Variants {
  return {
    hidden: reduced ? { opacity: 0 } : { opacity: 0, y: 40, scale: 0.98 },
    show: reduced
      ? { opacity: 1, transition: { duration: 0.25 } }
      : { opacity: 1, y: 0, scale: 1, transition: settle(0.6) },
  };
}
function bentoVariants(reduced: boolean | null): Variants {
  return { hidden: {}, show: { transition: { staggerChildren: reduced ? 0 : BEAT } } };
}
function bentoItemVariants(reduced: boolean | null): Variants {
  return {
    hidden: reduced ? { opacity: 0 } : { opacity: 0, y: 52, scale: 0.95 },
    show: reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, transition: settle(0.6) },
  };
}

/* -------------------------------------------------------------- bento art */

/** Card 1 — voice orb: breathing rings around a lit core (idle motion). */
function VoiceArt({ reduced }: { reduced: boolean }) {
  return (
    <div className="relative w-32 h-20 flex items-center justify-center">
      {[0, 1].map((i) => (
        <motion.span
          key={i}
          className="absolute w-14 h-14 rounded-full border border-peach/30"
          animate={reduced ? undefined : { scale: [1, 1.35, 1], opacity: [0.5, 0.15, 0.5] }}
          transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut", delay: i * 1.3 }}
          style={{ left: "calc(50% - 1.75rem)", top: "calc(50% - 1.75rem)" }}
        />
      ))}
      <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-peach/40 to-peach/10 blur-sm absolute -left-1" />
      <div className="relative z-10 w-10 h-10 rounded-full bg-white/70 backdrop-blur-md border border-peach/30 flex items-center justify-center">
        <motion.span
          className="w-2.5 h-2.5 rounded-full bg-peach"
          animate={reduced ? undefined : { scale: [1, 1.4, 1] }}
          transition={{ duration: 1.3, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
    </div>
  );
}

/** Card 2 — manuscript diamond: slow rotation that settles on hover. */
function WriteArt({ reduced }: { reduced: boolean }) {
  return (
    <div className="relative w-24 h-20 flex items-center justify-center">
      <motion.div
        className="w-16 h-16 rotate-45 rounded-xl bg-gradient-to-br from-peach/40 via-peach/20 to-transparent border border-peach/30 shadow-sm flex items-center justify-center"
        animate={reduced ? undefined : { rotate: [45, 50, 45], scale: [1, 1.04, 1] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
      >
        <div className="w-8 h-8 -rotate-45 rounded-lg bg-white/70 backdrop-blur-xs flex items-center justify-center text-xs font-mono text-[#E8622C]">
          &para;
        </div>
      </motion.div>
    </div>
  );
}

/** Card 3 — income ring: continuously rotating dashed orbit, breathing core. */
function IncomeArt({ reduced }: { reduced: boolean }) {
  return (
    <div className="relative w-20 h-20 rounded-full border border-peach/30 bg-gradient-to-br from-peach/15 to-transparent flex items-center justify-center">
      <motion.div
        className="absolute inset-1 rounded-full border border-dashed border-peach/40"
        animate={reduced ? undefined : { rotate: 360 }}
        transition={{ duration: 14, repeat: Infinity, ease: "linear" }}
      />
      <motion.div
        className="w-5 h-5 rounded-full bg-peach/70 blur-[2px]"
        animate={reduced ? undefined : { scale: [1, 1.3, 1], opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 2.1, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}

/** Card 4 — journey: exactly THREE connected dots, first highlighted, with a
 * pulse traveling the connector. (Fixes the previous 5-dot contradiction.) */
function JourneyArt({ reduced }: { reduced: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="w-4 h-px bg-gray-300" />}
            {i === 0 ? (
              <motion.span
                className="w-3 h-3 rounded-full bg-[#E8622C] ring-4 ring-[#E8622C]/15"
                animate={reduced ? undefined : { scale: [1, 1.25, 1] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
              />
            ) : (
              <span className="w-2.5 h-2.5 rounded-full border-2 border-gray-300 bg-white" />
            )}
          </span>
        ))}
        {!reduced && (
          <motion.span
            className="absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-peach"
            animate={{ left: ["6%", "94%"], opacity: [0, 1, 1, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut", times: [0, 0.15, 0.85, 1] }}
          />
        )}
      </div>
      <motion.div
        className="w-16 h-14 rounded-lg bg-gradient-to-tr from-peach/40 to-transparent border border-peach/30 shadow-xs flex items-center justify-center"
        animate={reduced ? undefined : { y: [0, -3, 0] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
      >
        <span className="text-[10px] font-mono text-gray-600 font-medium">3 steps</span>
      </motion.div>
    </div>
  );
}

const BENTO = [
  { title: "We Learn Your Voice", body: "We immerse ourselves in your videos, capturing your exact phrasing, cadence, and lived insights.", Art: VoiceArt },
  { title: "Zero Writing Required", body: "No blank pages or writer's block. We assemble the complete manuscript; you simply review and sign off.", Art: WriteArt },
  { title: "Income As You Sleep", body: "Every release ships with its own storefront, checkout rails, and automated payouts. Your audience buys; the system delivers.", Art: IncomeArt },
  { title: "Your Journey", body: "Step-by-step author review. Digitally signed, watermarked, and legally protected under your own name.", Art: JourneyArt },
];

/* ------------------------------------------------------- pointer-3D bento */

function TiltCard({
  children,
  className,
  reduced,
  onOpen,
  active,
}: {
  children: React.ReactNode;
  className?: string;
  reduced: boolean;
  onOpen: () => void;
  active: boolean;
}) {
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const srx = useSpring(rx, HEAVY);
  const sry = useSpring(ry, HEAVY);
  const mx = useMotionValue(50);
  const my = useMotionValue(50);
  // Soft slab shadow: drifts gently opposite the tilt over a wide, faint base.
  // NOTE: all hooks hoisted here — conditional hook calls inside JSX crash React.
  const shadowX = useTransform(sry, [-8, 8], [3, -3]);
  const shadowYRaw = useTransform(srx, [-8, 8], [-3, 3]);
  const shadowY = useTransform(shadowYRaw, (v) => 26 + v);
  const sheen = useMotionTemplate`radial-gradient(340px circle at ${mx}% ${my}%, rgba(255,158,128,0.07), transparent 72%)`;
  const shadow = useMotionTemplate`${shadowX}px ${shadowY}px 60px rgba(0,0,0,0.045)`;

  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (reduced || active) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    ry.set((px - 0.5) * 5);
    rx.set((0.5 - py) * 5);
    mx.set(px * 100);
    my.set(py * 100);
  };
  const onLeave = () => {
    rx.set(0);
    ry.set(0);
    mx.set(50);
    my.set(50);
  };

  return (
    <motion.div
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      whileHover={reduced ? undefined : { y: -6, boxShadow: SHADOW_LIFT, transition: settle(0.45) }}
      style={{
        rotateX: srx,
        rotateY: sry,
        boxShadow: reduced ? undefined : shadow,
      }}
      className={className}
    >
      {!reduced && (
        <motion.div aria-hidden className="pointer-events-none absolute inset-0 rounded-[32px]" style={{ background: sheen }} />
      )}
      {children}
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open details"
        className="absolute bottom-5 right-5 w-9 h-9 rounded-full bg-white shadow-sm border border-black/5 flex items-center justify-center text-gray-700 hover:bg-charcoal hover:text-white transition-colors"
      >
        <ArrowIcon />
      </button>
    </motion.div>
  );
}

/* --------------------------------------------------------------- landing */

export default function LandingPage({ onboarding }: { onboarding: boolean }) {
  const reduced = useReducedMotion();
  const fine = useFinePointer();
  const [active, setActive] = useState<number | null>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ["start end", "end start"] });
  const blobY = useTransform(scrollYProgress, [0, 1], [-20, 20]);
  const blobY2 = useTransform(scrollYProgress, [0, 1], [16, -16]);

  /* Entrance construction — the page builds itself with a beat (hoisted factories). */
  const rise = riseVariants(reduced);
  const bentoContainer = bentoVariants(reduced);
  const bentoItem = bentoItemVariants(reduced);

  const steps = active === null ? null : DETAILS[active].steps;

  return (
    <div className="min-h-screen p-4 sm:p-8 md:p-12 flex flex-col justify-between pb-32 lg:pb-12 overflow-x-clip">
      <div className="max-w-[1240px] w-full mx-auto flex flex-col gap-6 md:gap-8">
        {/* Header — words construct upward */}
        <motion.header variants={rise} initial="hidden" animate="show" className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl sm:text-4xl md:text-5xl tracking-tight text-gray-900 font-normal">
              Hello, <span className="font-bold">creator</span>
            </h1>
            <p className="text-sm sm:text-base text-gray-500 mt-1 sm:mt-2">
              A dedicated publishing house for <b className="text-gray-700 font-medium">your lived wisdom</b> and{" "}
              <b className="text-gray-700 font-medium">lasting legacy</b>.
            </p>
          </div>
          <Link href="/" className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900 group">
            <span className="text-gray-400 font-light">{"{"}</span>
            <span className="text-gray-900">expanpress</span>
            <span className="text-gray-400 font-light">{"}"}</span>
          </Link>
        </motion.header>

        <div className="flex flex-col lg:flex-row gap-5 md:gap-7 items-stretch">
          {/* Dock — desktop rail; tablet/mobile: fixed bottom glass bar */}
          <motion.nav
            variants={rise}
            initial="hidden"
            animate="show"
            className="hidden lg:flex flex-col justify-center items-center gap-4 py-6 px-3 rounded-full glass-card dock-shadow shrink-0 self-center"
            aria-label="Quick Navigation"
          >
            {DOCK_ITEMS.slice(0, 2).map((it) => <DockLink key={it.title} {...it} />)}
            <motion.div
              className="w-11 h-11 rounded-2xl bg-white border border-peach/50 flex items-center justify-center text-gray-900 font-bold text-sm"
              animate={reduced ? undefined : { boxShadow: ["0 2px 14px rgba(255,158,128,0.35)", "0 2px 22px rgba(255,158,128,0.6)", "0 2px 14px rgba(255,158,128,0.35)"] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
            >
              {"{ }"}
            </motion.div>
            {DOCK_ITEMS.slice(2).map((it) => <DockLink key={it.title} {...it} />)}
          </motion.nav>

          <motion.nav
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 70 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, transition: settle(0.6, 0.35) }}
            style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
            className="lg:hidden fixed inset-x-3 z-50 flex justify-center items-center gap-3 px-4 py-2.5 rounded-full glass-card dock-shadow"
            aria-label="Quick Navigation"
          >
            {DOCK_ITEMS.slice(0, 2).map((it) => <DockLink key={it.title} {...it} compact />)}
            <div className="w-10 h-10 rounded-2xl bg-white border border-peach/50 flex items-center justify-center text-gray-900 font-bold text-sm shrink-0">
              {"{" }
            </div>
            {DOCK_ITEMS.slice(2).map((it) => <DockLink key={it.title} {...it} compact />)}
          </motion.nav>

          {/* Hero — the charcoal slab; blobs drift on scroll, aura breathes */}
          <HeroCard heroRef={heroRef} reduced={Boolean(reduced)} blobY={blobY} blobY2={blobY2} />

          {/* Bento — pointer-3D cards; click splits the page */}
          <motion.div
            className="lg:w-[54%] grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-5 [perspective:1200px]"
            id="how-it-works"
            variants={bentoContainer}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.12 }}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              {BENTO.map((card, i) => {
                const Art = card.Art;
                const isActive = active === i;
                const isRail = active !== null && !isActive;
                return (
                  <motion.div
                    key={card.title}
                    id={i === 0 ? "voice" : undefined}
                                        layout
                    layoutId={`bento-${i}`}
                    variants={bentoItem}
                    transition={APPLE}
                    style={{ transformStyle: "preserve-3d", scrollMarginTop: "6rem" }}
                    animate={isRail ? { opacity: 0, scale: 0.95, pointerEvents: "none", transition: { duration: 0.3, ease: EASE } } : undefined}
                    className={isActive ? "sm:col-span-2 z-10" : ""}
                  >
                    <TiltCard
                      reduced={Boolean(reduced) || !fine}
                      active={isActive}
                      onOpen={() => setActive(i)}
                      className={`rounded-[32px] glass-card p-6 sm:p-7 flex flex-col justify-between relative overflow-hidden ${isActive ? "card-shadow" : "card-shadow"}`}
                    >
                      <div>
                        <h3 className="text-lg sm:text-xl font-bold tracking-tight text-gray-900">{card.title}</h3>
                        <p className="text-xs sm:text-sm text-gray-500 mt-1.5 leading-relaxed">{card.body}</p>
                      </div>
                      <div className="my-4 py-3 flex items-center justify-center relative">
                        <Art reduced={Boolean(reduced)} />
                      </div>
                      <AnimatePresence mode="wait">
                        {isActive && (
                          <motion.div
                            key="slide"
                            initial={reduced ? { opacity: 0 } : { opacity: 0, x: 56 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={reduced ? { opacity: 0 } : { opacity: 0, x: -40, transition: { duration: 0.25, ease: EASE } }}
                            transition={settle(0.45, 0.5)}
                            className="absolute inset-0 rounded-[32px] bg-charcoal text-white p-6 sm:p-8 flex flex-col"
                          >
                            <div className="flex items-center justify-between">
                              <div className="text-[11px] font-mono tracking-[0.16em] uppercase text-gray-400">
                                {card.title}
                              </div>
                              <button
                                type="button"
                                onClick={() => setActive(null)}
                                aria-label="Close details"
                                className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
                              >
                                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
                                  <path d="M6 6l12 12M18 6L6 18" />
                                </svg>
                              </button>
                            </div>
                            <ol className="mt-4 flex-1 flex flex-col justify-center gap-3">
                              {steps?.map((step, si) => (
                                <motion.li
                                  key={step}
                                  initial={reduced ? { opacity: 0 } : { opacity: 0, x: 40 }}
                                  animate={reduced ? { opacity: 1 } : { opacity: 1, x: 0 }}
                                  transition={{ duration: 0.45, ease: EASE, delay: 0.62 + si * BEAT * 4 }}
                                  className="flex items-center gap-3 text-sm text-gray-200"
                                >
                                  <span className="w-7 h-7 rounded-full border border-peach/50 text-peach font-mono text-xs flex items-center justify-center shrink-0">
                                    {si + 1}
                                  </span>
                                  <span className="font-medium">{step}</span>
                                </motion.li>
                              ))}
                            </ol>
                            <Link
                              href={SIGNIN}
                              className="group inline-flex items-center gap-3 text-sm font-semibold text-white hover:text-peach transition-colors self-start"
                            >
                              <span>Start this journey</span>
                              <span className="group-hover:translate-x-1 transition-transform">&rarr;</span>
                            </Link>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </TiltCard>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </motion.div>
        </div>

        {/* Spotlight bar — launch-state driven (no stale hard-coded claim) */}
        <SpotlightBar onboarding={onboarding} reduced={Boolean(reduced)} />

        <footer className="flex flex-wrap items-center justify-between gap-3 text-xs text-gray-400 px-2 pb-6 lg:pb-4">
          <div className="flex items-center gap-2">
            <span>&copy; 2026 ExpanPress</span>
            <span>&middot;</span>
            <span>A private publishing house for creators</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="/privacy.html" className="hover:text-gray-700 transition-colors">Privacy</a>
            <a href="/terms.html" className="hover:text-gray-700 transition-colors">Terms</a>
            <a href="/refund-policy.html" className="hover:text-gray-700 transition-colors">Refunds</a>
            <a href="mailto:support@expanpress.com" className="hover:text-gray-700 transition-colors">support@expanpress.com</a>
          </div>
        </footer>
      </div>
    </div>
  );
}

function DockLink({ href, title, d, compact }: { href: string; title: string; d: string; compact?: boolean }) {
  return (
    <a
      href={href}
      title={title}
      aria-label={title}
      className={`${compact ? "w-10 h-10" : "w-11 h-11"} rounded-2xl flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-black/5 transition-all`}
    >
      <DockIcon d={d} />
    </a>
  );
}

function HeroCard({
  heroRef,
  reduced,
  blobY,
  blobY2,
}: {
  heroRef: React.RefObject<HTMLDivElement | null>;
  reduced: boolean;
  blobY: ReturnType<typeof useTransform<number, number>>;
  blobY2: ReturnType<typeof useTransform<number, number>>;
}) {
  return (
    <motion.div
      ref={heroRef}
      variants={reduced ? { hidden: { opacity: 0 }, show: { opacity: 1 } } : {
        hidden: { opacity: 0, y: 60, scale: 0.98 },
        show: { opacity: 1, y: 0, scale: 1, transition: settle(0.6, 0.12) },
      }}
      initial="hidden"
      animate="show"
      className="lg:w-[46%] rounded-[32px] bg-charcoal text-white p-8 sm:p-10 md:p-12 relative overflow-hidden flex flex-col justify-between shadow-[0_20px_50px_rgba(0,0,0,0.12)] min-h-[460px] md:min-h-[520px]"
    >
      <motion.div aria-hidden className="absolute -left-12 top-1/4 w-36 h-72 bg-peach/20 rounded-full blur-3xl pointer-events-none" style={reduced ? undefined : { y: blobY }} />
      <motion.div aria-hidden className="absolute -right-10 bottom-10 w-28 h-56 bg-peach/10 rounded-full blur-3xl pointer-events-none" style={reduced ? undefined : { y: blobY2 }} />

      <div className="hidden sm:block absolute right-8 top-12 bottom-12 w-28 pointer-events-none opacity-30">
        <svg className="w-full h-full text-white" viewBox="0 0 100 300" fill="none" preserveAspectRatio="none">
          <path d="M100 0H60C26.8629 0 0 26.8629 0 60V90C0 123.137 26.8629 150 60 150H70C103.137 150 130 176.863 130 210V240C130 273.137 103.137 300 70 300H100" stroke="currentColor" strokeWidth="2" />
        </svg>
      </div>

      <div className="relative z-10">
        <div className="text-[11px] sm:text-xs font-mono font-medium tracking-[0.16em] uppercase text-gray-400 mb-6">
          ExpanPress &middot; Your Publishing House
        </div>
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-white leading-[1.12] max-w-sm">
          Your voice deserves to be a book.
        </h2>
        <p className="mt-5 text-sm sm:text-base text-gray-300 leading-relaxed max-w-sm">
          You&apos;ve spent years sharing your story on camera. We study your life&apos;s work, distill your core philosophy, and build a beautiful, author-grade book with you.
        </p>
        <p className="mt-3 text-xs sm:text-sm text-gray-400 font-medium">
          Zero writing required. We take your hand every step of the way.
        </p>
      </div>

      <div className="mt-8 flex items-center justify-between z-10">
        <a href={SIGNIN} className="group inline-flex items-center gap-4 text-sm font-semibold text-white hover:text-peach transition-colors">
          <span>Tap to begin</span>
          <span className="group-hover:translate-x-1 transition-transform">&rarr;</span>
        </a>
        {/* Living CTA: breathing peach aura + magnetic press */}
        <motion.a
          href={SIGNIN}
          title="Start your publishing journey"
          aria-label="Start your publishing journey"
          className="relative w-14 h-14 rounded-full bg-[#2A2A2A] hover:bg-[#383838] text-white flex items-center justify-center transition-colors"
          whileHover={reduced ? undefined : { scale: 1.07 }}
          whileTap={reduced ? undefined : { scale: 0.94 }}
          transition={settle(0.3)}
        >
          {!reduced && (
            <motion.span
              aria-hidden
              className="absolute inset-0 rounded-full bg-peach/50 blur-md"
              animate={{ scale: [1, 1.35, 1], opacity: [0.35, 0.75, 0.35] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
          <motion.span
            className="relative z-10"
            animate={reduced ? undefined : { x: [0, 3, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          >
            <ArrowIcon className="w-5 h-5" />
          </motion.span>
        </motion.a>
      </div>
    </motion.div>
  );
}

function SpotlightBar({ onboarding, reduced }: { onboarding: boolean; reduced: boolean }) {
  return (
    <motion.aside
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={settle(0.6)}
      id="spotlight"
      className="rounded-full glass-card dock-shadow px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4 transition-colors hover:bg-white mb-24 lg:mb-0"
    >
      <div className="flex items-center gap-3 sm:gap-4 overflow-hidden">
        <div className="w-8 h-8 rounded-xl bg-charcoal text-white shrink-0 flex items-center justify-center shadow-xs">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
        </div>
        <div className="text-xs sm:text-sm text-gray-600 truncate">
          <span className="font-bold text-gray-900 tracking-tight">{onboarding ? "NOW ONBOARDING" : "COMING SOON"}</span>
          <span className="mx-1 text-gray-300">&middot;</span>
          <span>
            {onboarding
              ? "Founding creators are joining for the first private releases."
              : "The first private releases are in preparation."}
          </span>
        </div>
      </div>
      <a href={SIGNIN} className="shrink-0 text-xs sm:text-sm font-semibold text-gray-800 hover:text-black flex items-center gap-1.5 group">
        <span>For Creators</span>
        <span className="group-hover:translate-x-0.5 transition-transform">&rarr;</span>
      </a>
    </motion.aside>
  );
}
