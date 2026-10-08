"use client";

import { useEffect } from "react";

/**
 * Buy CTA with attribution forwarding (Sprint 17 P3 — ports the retired
 * static page's capture script). ?src / ?dub_id on the landing URL are kept in
 * sessionStorage so they survive in-site navigation, then appended to the
 * checkout link on click; the route validates them and passes reference_id to the
 * provider. Client-side so the SSR page stays cacheable (reading searchParams
 * on the server would opt every request out of ISR). Storage failures never
 * block checkout — the plain link still works.
 */
const KEYS = { src: "ep_src", dub_id: "ep_dub_id" } as const;

function useAttributionCapture() {
  useEffect(() => {
    try {
      const qs = new URLSearchParams(window.location.search);
      for (const [param, key] of Object.entries(KEYS)) {
        const v = qs.get(param);
        if (v) sessionStorage.setItem(key, v);
      }
    } catch {
      /* attribution capture must never block checkout */
    }
  }, []);
}

/** Capture-only: for landing pages without a buy button (the creator hub). */
export function AttributionCapture() {
  useAttributionCapture();
  return null;
}

export function BuyLink({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  useAttributionCapture();

  // Forward on click (as the static page did): no state, no hydration mismatch.
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    try {
      const u = new URL(href, window.location.origin);
      for (const [param, key] of Object.entries(KEYS)) {
        const v = sessionStorage.getItem(key);
        if (v) u.searchParams.set(param, v);
      }
      e.currentTarget.href = u.pathname + u.search;
    } catch {
      /* leave the plain link on any failure */
    }
  };

  return (
    <a className={className} href={href} onClick={onClick}>
      {children}
    </a>
  );
}
