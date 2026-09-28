import type { Metadata } from "next";
import { Fraunces } from "next/font/google";
import "./astryx-tokens.css";
import "../../globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  style: ["normal"],
  display: "swap",
  variable: "--font-fraunces",
});

export const metadata: Metadata = {
  title: "Creator Portal · ExpanPress",
  robots: { index: false, follow: false }, // authenticated surface
};

/**
 * Creator portal layout (Wave 4): loads the Astryx neutral theme tokens
 * (extracted to astryx-tokens.css — the package is client-bound) and wires
 * Fraunces for the serif headings, matching the legacy portal typography.
 * Spacing/typography are consumed via Tailwind v4 var syntax (p-(--space-5)).
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${fraunces.className} [--font-serif:var(--font-fraunces)]`} data-creator-portal>
      {children}
    </div>
  );
}
