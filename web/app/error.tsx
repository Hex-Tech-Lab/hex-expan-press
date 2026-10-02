"use client";

import Link from "next/link";
import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Route error boundary for the App Router: keeps a client-side crash from
 * showing Next's default unbranded error screen. Offers a real recovery
 * action (reset re-renders the segment) and a way home.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <div className="min-h-screen bg-canvas text-charcoal flex flex-col items-center justify-center gap-5 p-8 font-sans">
      <div className="w-12 h-12 rounded-2xl bg-white border border-peach/50 shadow-[0_2px_14px_rgba(255,158,128,0.45)] flex items-center justify-center font-bold">
        {"{ }"}
      </div>
      <h1 className="text-2xl font-bold tracking-tight">Something broke while loading.</h1>
      <p className="text-sm text-gray-600 max-w-sm text-center">
        The page hit an unexpected error. Retry — or head back to the front page.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="px-5 h-11 rounded-full bg-charcoal text-white text-sm font-semibold hover:bg-[#383838] transition-colors"
        >
          Try again
        </button>
        <Link href="/" className="px-5 h-11 rounded-full glass-card text-sm font-semibold text-gray-800 hover:text-black transition-colors">
          Back home
        </Link>
      </div>
      {error.digest ? <p className="text-[10px] font-mono text-gray-600">ref: {error.digest}</p> : null}
    </div>
  );
}
