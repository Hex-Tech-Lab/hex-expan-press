// Targets are public or unauthenticated endpoints only. No credential is ever
// sent to any of them. Edit this list to change what the probe measures.
export type Target = { id: string; url: string; why: string };

export const TARGETS: Target[] = [
  { id: "expanpress-home", url: "https://expanpress.com/", why: "Buyer landing page (creator house)" },
  { id: "expanpress-terms", url: "https://expanpress.com/terms.html", why: "Static legal page, origin without app logic" },
  { id: "paddle-api", url: "https://api.paddle.com/", why: "Live Paddle API origin; checkout backend dependency" },
  { id: "paddle-sandbox-api", url: "https://sandbox-api.paddle.com/", why: "Paddle sandbox API origin" },
  { id: "paddle-cdn-js", url: "https://cdn.paddle.com/paddle/v2/paddle.js", why: "Paddle.js loader, required on checkout" },
  { id: "supabase-rest", url: "https://hywqftbcjhfjegypzpzd.supabase.co/rest/v1/", why: "Supabase REST root (expect 401, timing only)" },
  { id: "upstash-rest-prod", url: "https://needed-seahorse-135345.upstash.io/", why: "Upstash REST host for expanpress-prod (expect 401, timing only)" },
];

// Every target is measured on every run, so each endpoint keeps an unbroken series.
export const REFERENCE_TARGET_IDS = TARGETS.map((t) => t.id);
