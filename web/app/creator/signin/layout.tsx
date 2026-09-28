import { Fraunces } from "next/font/google";
import "../../globals.css";
import "../dashboard/astryx-tokens.css";
import type { Metadata } from "next";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  style: ["normal"],
  display: "swap",
  variable: "--font-fraunces",
});

export const metadata: Metadata = {
  title: "Sign in · ExpanPress",
};

/**
 * Creator sign-in layout (Wave 5): shares the Astryx tokens + Fraunces with
 * the dashboard so the portal surfaces look identical.
 */
export default function SignInLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${fraunces.className} [--font-serif:var(--font-fraunces)]`} data-creator-portal>
      {children}
    </div>
  );
}
