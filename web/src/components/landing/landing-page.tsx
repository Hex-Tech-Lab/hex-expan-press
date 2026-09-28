"use client";

import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import Link from "next/link";
import { useRef } from "react";

const SIGNIN = "/creator/signin/";

type DockItem = {
  href: string;
  title: string;
  icon: React.ReactNode;
};

const ArrowUpRight = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

const DOCK_ITEMS: DockItem[] = [
  {
    href: SIGNIN,
    title: "Creator Sign In",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    href: "#voice",
    title: "Your Audience",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 11l18-5v12L3 14v-3z" />
        <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
      </svg>
    ),
  },
  {
    href: "#how-it-works",
    title: "How It Works",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      </svg>
    ),
  },
  {
    href: SIGNIN,
    title: "Notifications",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
    ),
  },
];

function DockButton({ item }: { item: DockItem }) {
  return (
    <a
      href={item.href}
      title={item.title}
      aria-label={item.title}
      className="w-11 h-11 rounded-2xl flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-black/5 transition-all"
    >
      {item.icon}
    </a>
  );
}

function Dock() {
  return (
    <>
      {/* Desktop: vertical glass rail (legacy layout) */}
      <nav
        className="hidden lg:flex flex-col justify-center items-center gap-4 py-6 px-3 rounded-full glass-card dock-shadow shrink-0 self-center"
        aria-label="Quick Navigation"
      >
        <DockButton item={DOCK_ITEMS[0]} />
        <DockButton item={DOCK_ITEMS[1]} />
        <div className="w-11 h-11 rounded-2xl bg-white shadow-[0_2px_14px_rgba(255,158,128,0.45)] border border-peach/50 flex items-center justify-center text-gray-900 font-bold text-sm">
          {"{ }"}
        </div>
        <DockButton item={DOCK_ITEMS[2]} />
        <DockButton item={DOCK_ITEMS[3]} />
      </nav>

      {/* Tablet + mobile: same glass pill as a fixed bottom bar */}
      <nav
        className="lg:hidden fixed bottom-3 inset-x-3 z-50 flex justify-center items-center gap-4 px-5 py-2.5 rounded-full glass-card dock-shadow"
        aria-label="Quick Navigation"
      >
        <DockButton item={DOCK_ITEMS[0]} />
        <DockButton item={DOCK_ITEMS[1]} />
        <div className="w-10 h-10 rounded-2xl bg-white shadow-[0_2px_14px_rgba(255,158,128,0.45)] border border-peach/50 flex items-center justify-center text-gray-900 font-bold text-sm shrink-0">
          {"{ }"}
        </div>
        <DockButton item={DOCK_ITEMS[2]} />
        <DockButton item={DOCK_ITEMS[3]} />
      </nav>
    </>
  );
}

function HeroCard({ reduced }: { reduced: boolean }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: cardRef,
    offset: ["start end", "end start"],
  });
  const blobY = useTransform(scrollYProgress, [0, 1], [-18, 18]);
  const blobY2 = useTransform(scrollYProgress, [0, 1], [14, -14]);

  return (
    <div
      ref={cardRef}
      className="lg:w-[46%] rounded-[32px] bg-charcoal text-white p-8 sm:p-10 md:p-12 relative overflow-hidden flex flex-col justify-between shadow-[0_20px_50px_rgba(0,0,0,0.12)] min-h-[460px] md:min-h-[520px]"
    >
      <motion.div
        aria-hidden
        className="absolute -left-12 top-1/4 w-36 h-72 bg-peach/20 rounded-full blur-3xl pointer-events-none"
        style={reduced ? undefined : { y: blobY }}
      />
      <motion.div
        aria-hidden
        className="absolute -right-10 bottom-10 w-28 h-56 bg-peach/10 rounded-full blur-3xl pointer-events-none"
        style={reduced ? undefined : { y: blobY2 }}
      />

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
        <a
          href={SIGNIN}
          className="group inline-flex items-center gap-4 text-sm font-semibold text-white hover:text-peach transition-colors"
        >
          <span>Tap to begin</span>
          <span className="group-hover:translate-x-1 transition-transform">&rarr;</span>
        </a>
        <motion.a
          href={SIGNIN}
          title="Start your publishing journey"
          aria-label="Start your publishing journey"
          whileHover={reduced ? undefined : { scale: 1.06 }}
          whileTap={reduced ? undefined : { scale: 0.95 }}
          className="w-14 h-14 rounded-full bg-[#2A2A2A] hover:bg-[#383838] text-white flex items-center justify-center transition-colors shadow-md"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </motion.a>
      </div>
    </div>
  );
}

const BENTO = [
  {
    title: "We Learn Your Voice",
    body: "We immerse ourselves in your videos, capturing your exact phrasing, cadence, and lived insights.",
    art: (
      <div className="relative w-32 h-20 flex items-center justify-center">
        <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-peach/40 to-peach/10 blur-sm absolute -left-1" />
        <div className="w-16 h-16 rounded-full bg-gradient-to-bl from-peach/60 to-peach/20 blur-xs absolute right-1" />
        <div className="w-10 h-10 rounded-full bg-white/60 backdrop-blur-md border border-peach/30 z-10 flex items-center justify-center">
          <span className="w-2 h-2 rounded-full bg-peach" />
        </div>
      </div>
    ),
  },
  {
    title: "Zero Writing Required",
    body: "No blank pages or writer's block. We assemble the complete manuscript; you simply review and sign off.",
    art: (
      <div className="relative w-24 h-20 flex items-center justify-center">
        <div className="w-16 h-16 rotate-45 rounded-xl bg-gradient-to-br from-peach/40 via-peach/20 to-transparent border border-peach/30 shadow-sm flex items-center justify-center">
          <div className="w-8 h-8 rounded-lg bg-white/70 backdrop-blur-xs flex items-center justify-center text-xs font-mono text-[#E8622C]">
            &para;
          </div>
        </div>
      </div>
    ),
  },
  {
    title: "Income As You Sleep",
    body: "Every release ships with its own storefront, checkout rails, and automated payouts. Your audience buys; the system delivers.",
    art: (
      <div className="relative w-20 h-20 rounded-full border border-peach/30 bg-gradient-to-br from-peach/15 to-transparent flex items-center justify-center">
        <div className="w-12 h-12 rounded-full border border-dashed border-peach/40 flex items-center justify-center">
          <div className="w-5 h-5 rounded-full bg-peach/60 blur-[2px]" />
        </div>
      </div>
    ),
  },
  {
    title: "Your Journey",
    body: "Step-by-step author review. Digitally signed, watermarked, and legally protected under your own name.",
    art: (
      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-[#E8622C]" />
          <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
          <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
          <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
          <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
        </div>
        <div className="w-16 h-14 rounded-lg bg-gradient-to-tr from-peach/40 to-transparent border border-peach/30 shadow-xs flex items-center justify-center">
          <span className="text-[10px] font-mono text-gray-600 font-medium">3 steps</span>
        </div>
      </div>
    ),
  },
];

const HARD_SHADOW = "8px 8px 0 0 rgba(24, 24, 24, 0.08)";

export default function LandingPage() {
  const reduced = useReducedMotion();
  const container = {
    hidden: {},
    show: { transition: { staggerChildren: reduced ? 0 : 0.12 } },
  };
  const item = {
    hidden: reduced ? { opacity: 1 } : { opacity: 0, y: 24 },
    show: reduced ? { opacity: 1 } : { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" as const } },
  };

  return (
    <div className="min-h-screen p-4 sm:p-8 md:p-12 flex flex-col justify-between pb-28 lg:pb-12">
      <div className="max-w-[1240px] w-full mx-auto flex flex-col gap-6 md:gap-8">
        <header className="flex items-start justify-between">
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
        </header>

        <div className="flex flex-col lg:flex-row gap-5 md:gap-7 items-stretch">
          <Dock />
          <HeroCard reduced={Boolean(reduced)} />

          <motion.div
            className="lg:w-[54%] grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-5"
            id="how-it-works"
            variants={container}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.15 }}
          >
            {BENTO.map((card) => (
              <motion.div
                key={card.title}
                variants={item}
                whileHover={
                  reduced
                    ? undefined
                    : { x: -3, y: -3, boxShadow: HARD_SHADOW, transition: { type: "spring", stiffness: 320, damping: 22 } }
                }
                className="rounded-[32px] glass-card card-shadow p-6 sm:p-7 flex flex-col justify-between relative overflow-hidden group"
              >
                <div>
                  <h3 className="text-lg sm:text-xl font-bold tracking-tight text-gray-900">{card.title}</h3>
                  <p className="text-xs sm:text-sm text-gray-500 mt-1.5 leading-relaxed">{card.body}</p>
                </div>
                <div className="my-4 py-3 flex items-center justify-center relative">{card.art}</div>
                <a
                  href={SIGNIN}
                  aria-label={`Start with ExpanPress: ${card.title}`}
                  className="w-9 h-9 rounded-full bg-white shadow-sm border border-black/5 flex items-center justify-center self-end group-hover:scale-110 group-hover:bg-charcoal group-hover:text-white transition-all text-gray-700"
                >
                  <ArrowUpRight />
                </a>
              </motion.div>
            ))}
          </motion.div>
        </div>

        <motion.aside
          initial={reduced ? false : { opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          className="rounded-full glass-card dock-shadow px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4 transition-colors hover:bg-white mb-20 lg:mb-0"
        >
          <div className="flex items-center gap-3 sm:gap-4 overflow-hidden">
            <div className="w-8 h-8 rounded-xl bg-charcoal text-white shrink-0 flex items-center justify-center shadow-xs">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
            </div>
            <div className="text-xs sm:text-sm text-gray-600 truncate">
              <span className="font-bold text-gray-900 tracking-tight">NOW ONBOARDING</span>
              <span className="mx-1 text-gray-300">&middot;</span>
              <span>Founding creators are joining for the first private releases.</span>
            </div>
          </div>
          <a
            href={SIGNIN}
            className="shrink-0 text-xs sm:text-sm font-semibold text-gray-800 hover:text-black flex items-center gap-1.5 group"
          >
            <span>For Creators</span>
            <span className="group-hover:translate-x-0.5 transition-transform">&rarr;</span>
          </a>
        </motion.aside>

        <footer className="flex flex-wrap items-center justify-between gap-3 text-xs text-gray-400 px-2 pb-4">
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
