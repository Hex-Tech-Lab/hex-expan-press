import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_DIRS = [
  path.join(process.cwd(), "data", "settings"),
  path.join(HERE, "..", "..", "data", "settings"),
];
const TERMS_FILE_NAME = "terms.json";
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export interface CreatorTerms {
  creator_id: string;
  product_id: string;
  effective_from: string;
  creator_split_pct: number;
  note?: string;
}

type ValidatedTerms = CreatorTerms & { effMs: number };

function nonEmptyStr(src: string, key: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`terms: ${src} "${key}" must be a non-empty string (got ${JSON.stringify(v)})`);
  }
  return v;
}

function effectiveFromMs(src: string, v: string): number {
  if (!ISO_8601_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new Error(`terms: ${src} "effective_from" must be an ISO-8601 UTC date or full timestamp (got ${JSON.stringify(v)})`);
  }
  return Date.parse(v);
}

function validateEntry(raw: unknown, src: string): ValidatedTerms {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`terms: ${src} must be a JSON object`);
  }
  const e = raw as Record<string, unknown>;
  const pct = e["creator_split_pct"];
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error(`terms: ${src} "creator_split_pct" must be a finite number within 0-100 (got ${String(pct)})`);
  }
  const entry: ValidatedTerms = {
    creator_id: nonEmptyStr(src, "creator_id", e["creator_id"]),
    product_id: nonEmptyStr(src, "product_id", e["product_id"]),
    effective_from: nonEmptyStr(src, "effective_from", e["effective_from"]),
    creator_split_pct: pct,
    effMs: 0,
  };
  entry.effMs = effectiveFromMs(src, entry.effective_from);
  if (e["note"] !== undefined) {
    if (typeof e["note"] !== "string") throw new Error(`terms: ${src} "note" must be a string when present`);
    entry.note = e["note"];
  }
  return entry;
}

function validateTermsDoc(parsed: unknown, src: string): ValidatedTerms[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`terms: ${src} must contain a single JSON object with a "terms" array`);
  }
  const list = (parsed as Record<string, unknown>)["terms"];
  if (!Array.isArray(list)) {
    throw new Error(`terms: ${src} "terms" must be an array`);
  }
  return list.map((e, i) => validateEntry(e, `${src}[${i}]`));
}

function loadTerms(): ValidatedTerms[] {
  for (const dir of CANDIDATE_DIRS) {
    const p = path.join(dir, TERMS_FILE_NAME);
    if (!existsSync(p)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch (err) {
      throw new Error(`terms: cannot parse ${p}: ${(err as Error).message}`);
    }
    return validateTermsDoc(parsed, p);
  }
  throw new Error(
    `terms: ${TERMS_FILE_NAME} not found — creator revenue terms must live in data/settings/${TERMS_FILE_NAME} (looked in ${CANDIDATE_DIRS.join(", ")}); no inline defaults are permitted`,
  );
}

export function effectiveCreatorSplitPct(creator_id: string, product_id: string, atISO: string): number | null {
  if (typeof creator_id !== "string" || creator_id.trim() === "") {
    throw new TypeError("terms: creator_id must be a non-empty string");
  }
  if (typeof product_id !== "string" || product_id.trim() === "") {
    throw new TypeError("terms: product_id must be a non-empty string");
  }
  if (typeof atISO !== "string" || Number.isNaN(Date.parse(atISO))) {
    throw new TypeError(`terms: atISO must be a parseable timestamp (got ${String(atISO)})`);
  }
  const atMs = Date.parse(atISO);
  let winner: { pct: number; effMs: number } | null = null;
  for (const t of loadTerms()) {
    if (t.creator_id !== creator_id || t.product_id !== product_id) continue;
    if (t.effMs > atMs) continue;
    if (!winner || t.effMs >= winner.effMs) winner = { pct: t.creator_split_pct, effMs: t.effMs };
  }
  return winner ? winner.pct : null;
}

/**
 * DB-backed split resolution (Sprint 15 heritage eradication — replaces the
 * terms.json file read in the webhook money path; creator_terms is the SSOT,
 * Rule #0 private: RLS enabled with NO client policies, service_role only).
 *
 * Same semantics as effectiveCreatorSplitPct: the row with the LATEST
 * effective_from that is still <= the sale timestamp wins; null when no
 * terms row covers the creator/product pair (the caller treats null as a
 * hard failure → 500 → provider retries).
 *
 * Fail closed: an unconfigured Supabase admin client THROWS (never silently
 * returns null — a null means "no terms", a throw means "cannot determine").
 */
export async function effectiveCreatorSplitPctAsync(creatorHandle: string, storeProductId: string, atISO: string): Promise<number | null> {
  if (typeof creatorHandle !== "string" || creatorHandle.trim() === "") {
    throw new TypeError("terms: creatorHandle must be a non-empty string");
  }
  if (typeof storeProductId !== "string" || storeProductId.trim() === "") {
    throw new TypeError("terms: storeProductId must be a non-empty string");
  }
  if (typeof atISO !== "string" || Number.isNaN(Date.parse(atISO))) {
    throw new TypeError(`terms: atISO must be a parseable timestamp (got ${String(atISO)})`);
  }
  const { getSupabaseAdmin } = await import("./supabase_admin.ts");
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("terms: Supabase admin client unavailable — split resolution cannot run (fail closed)");
  }
  const [{ data: creator, error: creatorErr }, { data: product, error: productErr }] = await Promise.all([
    supabase.from("creators").select("id").eq("handle", creatorHandle).maybeSingle(),
    supabase.from("products").select("id").eq("store_product_id", storeProductId).maybeSingle(),
  ]);
  // A DB failure is NOT "no terms" — fail loud so the provider retries instead
  // of settling the payout on a defaulted split.
  if (creatorErr) throw new Error(`terms: creator lookup failed (${creatorHandle}): ${creatorErr.message}`);
  if (productErr) throw new Error(`terms: product lookup failed (${storeProductId}): ${productErr.message}`);
  if (!creator?.id || !product?.id) return null;
  const { data, error } = await supabase
    .from("creator_terms")
    .select("creator_split_pct, effective_from")
    .eq("creator_id", creator.id as string)
    .eq("product_id", product.id as string)
    .lte("effective_from", new Date(Date.parse(atISO)).toISOString())
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`terms: creator_terms lookup failed (${creatorHandle}/${storeProductId}): ${error.message}`);
  }
  // numeric(5,2) arrives from PostgREST as a STRING (the ledger learned this
  // the hard way — see ledger.ts) — coerce and validate before the money math.
  if (!data) return null;
  const pct = Number((data as { creator_split_pct: string | number }).creator_split_pct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error(`terms: creator_terms returned a non-numeric split for (${creatorHandle}/${storeProductId})`);
  }
  return pct;
}
