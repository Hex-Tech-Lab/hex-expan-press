import type { Metadata } from "next";
import LandingPage from "../src/components/landing/landing-page";

export const metadata: Metadata = {
  title: "ExpanPress · Your Voice Deserves to Be a Book",
  description:
    "A private publishing house for elite creators. We study your life's work, craft your digital book, and build your passive revenue stream. Zero writing required.",
  alternates: { canonical: "https://expanpress.com/" },
  openGraph: {
    type: "website",
    siteName: "ExpanPress",
    title: "ExpanPress · Your Voice Deserves to Be a Book",
    description:
      "We study your life's work, craft your digital book, and handle everything from publishing to payouts. Zero writing required.",
    url: "https://expanpress.com/",
  },
  twitter: { card: "summary_large_image" },
};

export default function Home() {
  return <LandingPage />;
}
