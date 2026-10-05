/**
 * One-shot retry wrapper for the PostgREST clock-skew 401 (HEX-EXPAN-PRESS-4).
 *
 * Right after sign-in a freshly minted JWT can carry an `iat` a few seconds in
 * the future; PostgREST rejects it with 401 PGRST303 ("JWT issued at future").
 * A single short delay + one retry absorbs the skew. Any other 401 (e.g.
 * PGRST301 expired), any other status, and any non-JSON body is returned
 * untouched — retried at most once, never on ReadableStream bodies.
 *
 * Sprint-13 idempotency gate (ADR-0059): the retry is restricted to GET and
 * HEAD. A retried mutation (POST/PATCH/PUT/DELETE) is a replay risk even when
 * the first attempt's 401 came from JWT verification — the safety argument
 * "PGRST303 is rejected before any transaction begins" is a behavioral claim
 * about PostgREST versions; the method gate makes replay structurally
 * impossible instead of trusting that claim. Non-idempotent requests are
 * returned untouched on ANY 401.
 */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

function requestMethod(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): string {
  const fromInit = init?.method;
  if (fromInit) return fromInit.toUpperCase();
  if (typeof input === "object" && input !== null && "method" in input) {
    const m = (input as Request).method;
    if (m) return m.toUpperCase();
  }
  return "GET";
}

export function createSkewRetryFetch(
  baseFetch: typeof fetch,
  delayMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await baseFetch(input, init);
    if (res.status !== 401) return res;
    if (!IDEMPOTENT_METHODS.has(requestMethod(input, init))) return res; // mutations are NEVER retried
    if (init && init.body instanceof ReadableStream) return res;

    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {
      return res; // non-JSON 401 — not ours
    }
    const b = body as { code?: unknown; message?: unknown } | null;
    const isSkew =
      b?.code === "PGRST303" ||
      (typeof b?.message === "string" && b.message.includes("JWT issued at future"));
    if (!isSkew) return res;

    await sleep(delayMs);
    return baseFetch(input, init);
  };
}
