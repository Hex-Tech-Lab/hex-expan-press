import type { SupabaseClient } from "@supabase/supabase-js";

export interface PrimaryProductResult<T = Record<string, unknown>> {
  product: T | null;
  error: Error | { message: string } | null;
}

/**
 * Shared, deterministic product resolution for the creator portal.
 * Always orders by created_at ASC, id ASC and limits to 1.
 */
export async function resolvePrimaryProduct<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  columns: string,
): Promise<PrimaryProductResult<T>> {
  const query = supabase
    .from("products")
    .select(columns)
    .order("created_at", { ascending: true });

  const orderedQuery = typeof (query as { order?: unknown }).order === "function"
    ? query.order("id", { ascending: true })
    : query;

  const { data, error } = await orderedQuery.limit(1);

  if (error) {
    return { product: null, error };
  }

  const product = (data?.[0] as T) ?? null;
  return { product, error: null };
}
