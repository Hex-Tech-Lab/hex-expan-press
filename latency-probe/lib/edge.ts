// Cache and edge facts that Vercel adds to a response. They say whether a slow or fast check was
// served from the edge cache, and from which region. Stored per check so the dashboard can explain dips.
export type EdgeFacts = {
  c: string | null; // x-vercel-cache: HIT, MISS, STALE, PRERENDER, BYPASS, REVALIDATED or UPDATED
  ed: string | null; // edge region code from x-vercel-id, for example fra1 or iad1
  ag: number | null; // age in seconds of a cached response
};

type Headers = Record<string, string | string[] | undefined>;

const CACHE_STATES = new Set(["HIT", "MISS", "STALE", "PRERENDER", "BYPASS", "REVALIDATED", "UPDATED"]);
const REGION = /^[a-z]{3}\d{1,2}$/;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function edgeFacts(h: Headers): EdgeFacts {
  const cache = (first(h["x-vercel-cache"]) ?? "").trim().toUpperCase();
  // The id starts with the region that served the request, for example "fra1::abcd-1793570495476-..."
  const region = (first(h["x-vercel-id"]) ?? "").split(":")[0];
  const age = (first(h["age"]) ?? "").trim();
  return {
    c: CACHE_STATES.has(cache) ? cache : null,
    ed: REGION.test(region) ? region : null,
    ag: /^\d{1,9}$/.test(age) ? Number(age) : null,
  };
}
