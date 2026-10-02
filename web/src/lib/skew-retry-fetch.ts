/**
 * One-shot retry wrapper for the PostgREST clock-skew 401 (HEX-EXPAN-PRESS-4).
 *
 * Right after sign-in a freshly minted JWT can carry an `iat` a few seconds in
 * the future; PostgREST rejects it with 401 PGRST303 ("JWT issued at future").
 * A single short delay + one retry absorbs the skew. Any other 401 (e.g.
 * PGRST301 expired), any other status, and any non-JSON body is returned
 * untouched — retried at most once, never on ReadableStream bodies.
 */
export function createSkewRetryFetch(
  baseFetch: typeof fetch,
  delayMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await baseFetch(input, init);
    if (res.status !== 401) return res;
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
