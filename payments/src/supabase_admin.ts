/**
 * Single source for service-role Supabase clients (sprint 12 Task 3 — debt
 * extraction from ledger.ts's 7× `SUPABASE_URL/SECRET_KEY guard + dynamic
 * import + createClient` pattern).
 *
 * Returns the client, or NULL when SUPABASE_URL/SUPABASE_SECRET_KEY are
 * unconfigured. The CALLER owns the null policy — that is deliberate, because
 * the correct behavior differs per call site and must NOT be flattened:
 *   * money-path writes fail CLOSED (throw → 500 → provider retries),
 *   * tolerant lookups return null (treated as "no ledger yet"),
 *   * inbox writes always throw (a 202 without a durable row drops the event).
 *
 * Transport guard (2026-11-11): the service key is a Bearer credential, so every
 * client built here is refused unless its URL is https (loopback http is allowed
 * for local development). The guard runs before the client is constructed, so a
 * plaintext URL never receives the key. Scripts that need their own URL/key pair
 * (scripts/sync-supabase-to-r2.ts) go through createServiceClient too.
 *
 * The dynamic import stays INSIDE this helper so `vi.mock("@supabase/supabase-js")`
 * in tests keeps intercepting client construction.
 */

type SupabaseClient = import("@supabase/supabase-js").SupabaseClient;

/** Throws unless the URL is https, or http to loopback. Call before any request or client that carries the service key. */
export function assertSecureSupabaseUrl(supabaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(supabaseUrl);
  } catch (err) {
    throw new Error("SUPABASE_URL is not a valid URL", { cause: err });
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`SUPABASE_URL must be https (got ${parsed.protocol}//${parsed.hostname}); the service key is sent as a Bearer token`);
  }
}

/** Builds a service-role client for an explicit URL and key, after the transport guard. */
export async function createServiceClient(
  url: string,
  key: string,
  options?: { auth?: { persistSession?: boolean } },
): Promise<SupabaseClient> {
  assertSecureSupabaseUrl(url);
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, key, options);
}

export async function getSupabaseAdmin(): Promise<SupabaseClient | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  const client = await createServiceClient(url, key);
  return client;
}
