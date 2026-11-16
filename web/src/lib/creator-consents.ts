import type { SupabaseClient } from "@supabase/supabase-js";
import type { PortalConsentRow } from "./consent-chain";

const PAGE_SIZE = 500;
const SAFETY_CAP = 5000;

export interface CreatorConsentsResult {
  rows: PortalConsentRow[];
  error: { message: string } | null;
}

function toError(e: unknown): { message: string } {
  const msg = (e as { message?: unknown } | null)?.message;
  return { message: typeof msg === "string" ? msg : String(e) };
}

/**
 * Every consent row for the creator who owns the product, bounded and ordered
 * deterministically. Supersession must see the creator's COMPLETE chain (a
 * successor on another product can supersede a row here), so the read is
 * creator-wide and never product-scoped. Reaching the safety cap is an error,
 * not a truncated success: a partial chain could hide a superseding refusal.
 *
 * `options.kinds` narrows the read to the listed consent kinds. Supersession is same-kind only,
 * so a kind-narrowed chain resolves each listed kind exactly as the full chain does.
 */
export async function loadCreatorConsentRows(
  supabase: SupabaseClient,
  creatorId: string | null | undefined,
  options: { kinds?: readonly string[] } = {},
): Promise<CreatorConsentsResult> {
  if (!creatorId) return { rows: [], error: { message: "product has no owner" } };
  const rows: PortalConsentRow[] = [];
  let offset = 0;
  while (offset < SAFETY_CAP) {
    let query = supabase
      .from("consents")
      .select("id, kind, decision, product_id, supersedes, supersedes_ids, document_sha256")
      .eq("creator_id", creatorId);
    if (options.kinds) query = query.in("kind", [...options.kinds]);
    const { data, error } = (await query
      .order("signed_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)) as { data: PortalConsentRow[] | null; error: unknown };
    if (error || !data) return { rows: [], error: toError(error ?? new Error("Missing consent data")) };
    rows.push(...data);
    if (data.length < PAGE_SIZE) return { rows, error: null };
    offset += PAGE_SIZE;
  }
  return { rows: [], error: { message: "consent history exceeds the safety cap" } };
}
