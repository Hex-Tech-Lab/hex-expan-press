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
 * The dynamic import stays INSIDE this helper so `vi.mock("@supabase/supabase-js")`
 * in tests keeps intercepting client construction.
 */

type SupabaseClient = import("@supabase/supabase-js").SupabaseClient;

// Coalesce simultaneous dynamic imports on the same tick without caching across sequential calls
// (preserves per-test vi.doMock("@supabase/supabase-js") overrides while avoiding concurrent SSR loader deadlocks).
let inflightSupabaseImport: Promise<typeof import("@supabase/supabase-js")> | null = null;

export async function getSupabaseAdmin(): Promise<SupabaseClient | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  if (!inflightSupabaseImport) {
    inflightSupabaseImport = import("@supabase/supabase-js").finally(() => {
      inflightSupabaseImport = null;
    });
  }
  const { createClient } = await inflightSupabaseImport;
  return createClient(url, key);
}
