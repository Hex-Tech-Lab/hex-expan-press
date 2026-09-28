import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ExpanPress · Your Voice Deserves to Be a Book",
  description:
    "A private publishing house for elite creators. We study your life's work, craft your digital book, and build your passive revenue stream. Zero writing required.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-canvas text-charcoal font-sans antialiased">{children}</body>
    </html>
  );
}
