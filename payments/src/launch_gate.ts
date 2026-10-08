/**
 * launch_gate.ts — pre-launch consent gate (extracted from the deleted
 * payments/bake_checkout.ts during the Sprint 15 heritage eradication).
 *
 * The static bake engine is gone (the checkout route + webhook resolve all
 * commercial state from Supabase now), but this gate remains the operator's
 * pre-launch control: it verifies IN SUPABASE that every mandatory consent
 * kind is actively given and — F6 — that the C2 head approved the product's
 * CURRENT release PDF (document_sha256 === products.release_sha256).
 *
 * Sprint 17: chain resolution is the SAME creator-wide strict resolver the
 * checkout route uses (strictActiveConsentKinds / strictChainHead), and the
 * database enforces the identical rule on the 'live' transition via the
 * products_launch_gate trigger. Run this before launching to get a readable
 * verdict; the trigger is the authority.
 */

import { normalizeSha256, strictActiveConsentKinds, strictChainHead, type ConsentChainRow } from "../../web/src/lib/consent-chain.ts";

export type ConsentKind = "C1_data_accuracy" | "C2_release_approval" | "C3_revenue_split";
const CONSENT_KINDS: ConsentKind[] = ["C1_data_accuracy", "C2_release_approval", "C3_revenue_split"];

export interface ConsentRow extends ConsentChainRow {
  signed_at: string | null;
  document_sha256?: string | null;
}

// Hermetic in tests: pass a fetchImpl; env is read lazily at call time, never
// at import time.
export const assertLaunchConsents = async (
  dbProductId: string,
  fetchImpl?: typeof fetch,
): Promise<void> => {
  const blocked = (why: string): never => {
    throw new Error(`launch blocked: ${dbProductId}: ${why}`);
  };
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!base || !key) {
    blocked("missing consent(s): SUPABASE_URL/SUPABASE_SECRET_KEY not configured");
  }
  const doFetch = fetchImpl ?? fetch;
  const getJson = async <T>(url: string, label: string, requireComplete = false): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { apikey: key!, Authorization: `Bearer ${key}`, ...(requireComplete ? { Prefer: "count=exact" } : {}) },
      });
    } catch (e) {
      return blocked(`${label} lookup failed: ${(e as Error).message}`);
    }
    if (!res.ok) blocked(`${label} lookup HTTP ${res.status}`);
    let body: T;
    try {
      body = (await res.json()) as T;
    } catch (e) {
      return blocked(`${label} lookup returned unparseable body: ${(e as Error).message}`);
    }
    if (requireComplete) {
      // Supersession needs the COMPLETE chain: a response truncated by the
      // PostgREST row cap could omit a superseding row. Fail closed.
      const total = Number(res.headers.get("content-range")?.split("/")[1]);
      const got = Array.isArray(body) ? body.length : -1;
      if (!Number.isInteger(total) || total !== got) blocked(`${label} history incomplete (got ${got} of ${Number.isNaN(total) ? "unknown" : total})`);
    }
    return body;
  };

  // Product first: its owner scopes the creator-wide consent chain.
  const productRows = await getJson<Array<{ creator_id?: string | null; release_sha256?: string | null }>>(
    `${base}/rest/v1/products?id=eq.${encodeURIComponent(dbProductId)}&select=creator_id,release_sha256`,
    "release",
  );
  const productRow = productRows?.[0];
  const releaseSha = normalizeSha256(productRow?.release_sha256);
  if (!releaseSha) {
    const raw = productRow?.release_sha256;
    blocked(`product has no valid release_sha256 (got ${raw === undefined || raw === null ? "none" : JSON.stringify(raw)})`);
  }
  const ownerId = productRow?.creator_id;
  if (!ownerId) blocked("product has no owner");

  const rows = await getJson<ConsentRow[]>(
    `${base}/rest/v1/consents?creator_id=eq.${encodeURIComponent(ownerId!)}` +
      `&select=id,kind,decision,product_id,signed_at,supersedes,document_sha256` +
      `&order=signed_at.desc,id.desc`,
    "consent",
    true,
  );
  for (const r of rows) {
    if (r.signed_at === null || r.signed_at === undefined) blocked(`consent ${r.id ?? r.kind} has null signed_at`);
  }

  const active = strictActiveConsentKinds(rows, dbProductId);
  const missing = CONSENT_KINDS.filter((k) => !active.has(k));
  if (missing.length > 0) blocked(`missing consent(s): ${missing.join(", ")}`);

  // F6: the C2 head must have approved the product's CURRENT release PDF.
  const c2Head = strictChainHead(rows, dbProductId, "C2_release_approval")!;
  const approvedSha = normalizeSha256(c2Head.document_sha256);
  if (!approvedSha) blocked(`C2 approval ${c2Head.id} has no valid document_sha256`);
  if (approvedSha !== releaseSha) {
    blocked(`C2 approved a different release (approved ${approvedSha}, current ${releaseSha})`);
  }
};
