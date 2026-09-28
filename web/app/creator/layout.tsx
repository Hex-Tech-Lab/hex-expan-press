import { Fraunces } from "next/font/google";
import "../globals.css";
import "./astryx-tokens.css";
import type { Metadata } from "next";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  style: ["normal"],
  display: "swap",
  variable: "--font-fraunces",
});

export const metadata: Metadata = {
  title: "Creator Portal · ExpanPress",
  robots: { index: false, follow: false }, // authenticated portal surface
};

/**
 * Creator portal layout (Wave 4; hoisted to /creator level in Wave 6.1 so
 * dashboard, signin, review, and consents share ONE Astryx token + Fraunces
 * setup instead of one per route). Spacing/typography are consumed via
 * Tailwind v4 var syntax (p-(--space-5)).
 */
export default function CreatorLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${fraunces.className} [--font-serif:var(--font-fraunces)]`} data-creator-portal>
      {children}
    </div>
  );
}
