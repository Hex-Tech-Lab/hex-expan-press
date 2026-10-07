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
 * Call it before flipping a product's checkout_mode from 'gated' to a live
 * mode in the database. ADR-0060 references this bake-time layer; its runtime
 * counterpart (the checkout route consent gate) stays the live enforcement.
 */

export type ConsentKind = "C1_data_accuracy" | "C2_release_approval" | "C3_revenue_split";
const CONSENT_KINDS: ConsentKind[] = ["C1_data_accuracy", "C2_release_approval", "C3_revenue_split"];

export interface ConsentRow {
  id: string;
  kind: string;
  decision: string;
  signed_at: string | null;
  supersedes: string | null;
  document_sha256?: string | null;
}

// F6: a sha256 hex digest (lowercased) — anything else (missing/blank/all-zero/
// non-hex) fails closed.
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const ZERO_SHA256 = "0".repeat(64);

// Launch gate: every product sold through a provider must have the most recent
// consent row for each of C1/C2/C3 carrying decision "given" in Supabase.
// Chain resolution: chain head is a row of that kind whose id is not referenced
// by any other row's supersedes.
// Hermetic in tests: pass a fetchImpl; env is read lazily at call time, never
// at import time.
export const assertLaunchConsents = async (
  dbProductId: string,
  fetchImpl?: typeof fetch,
): Promise<void> => {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!base || !key) {
    throw new Error(`launch blocked: ${dbProductId}: missing consent(s): SUPABASE_URL/SUPABASE_SECRET_KEY not configured`);
  }
  const url =
    `${base}/rest/v1/consents?product_id=eq.${encodeURIComponent(dbProductId)}` +
    `&select=id,kind,decision,signed_at,supersedes,document_sha256` +
    `&order=signed_at.desc,id.desc`;
  const doFetch = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
  } catch (e) {
    throw new Error(`launch blocked: ${dbProductId}: consent lookup failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`launch blocked: ${dbProductId}: consent lookup HTTP ${res.status}`);
  }
  let rows: ConsentRow[];
  try {
    rows = (await res.json()) as ConsentRow[];
  } catch (e) {
    throw new Error(`launch blocked: ${dbProductId}: consent lookup returned unparseable body: ${(e as Error).message}`);
  }

  const rowsByKind = new Map<string, ConsentRow[]>();
  for (const r of rows) {
    if (r.signed_at === null || r.signed_at === undefined) {
      throw new Error(`launch blocked: ${dbProductId}: consent ${r.id ?? r.kind} has null signed_at`);
    }
    const list = rowsByKind.get(r.kind) ?? [];
    list.push(r);
    rowsByKind.set(r.kind, list);
  }

  for (const kind of CONSENT_KINDS) {
    const list = rowsByKind.get(kind);
    if (!list || list.length === 0) {
      throw new Error(`launch blocked: ${dbProductId}: missing consent(s): ${kind}`);
    }

    const supersededIds = new Set<string>();
    for (const r of list) {
      if (r.supersedes) supersededIds.add(r.supersedes);
    }

    const heads = list.filter((r) => !supersededIds.has(r.id));
    if (heads.length === 0) {
      throw new Error(`launch blocked: ${dbProductId}: no head found for consent kind ${kind}`);
    }
    if (heads.length > 1) {
      throw new Error(`launch blocked: ${dbProductId}: more than one head for consent kind ${kind}`);
    }

    const head = heads[0];
    if (head.decision !== "given") {
      throw new Error(`launch blocked: ${dbProductId}: consent ${kind} head decision is ${head.decision}`);
    }

    const conflictingSameSignedAt = list.find(
      (r) => r.signed_at === head.signed_at && r.decision !== head.decision,
    );
    if (conflictingSameSignedAt) {
      throw new Error(
        `launch blocked: ${dbProductId}: multiple rows for ${kind} with same signed_at but conflicting decision`,
      );
    }
  }

  // F6 (P1): the C2 head must have approved the product's CURRENT release PDF.
  // Fetch products.release_sha256 (same REST style as the consents lookup) and
  // fail closed unless the C2 head's document_sha256 equals it (case-insensitive,
  // both must be 64-hex). Missing/blank/zero hash or fetch failure → blocked.
  const c2Head = (() => {
    const list = rowsByKind.get("C2_release_approval")!;
    const supersededIds = new Set<string>();
    for (const r of list) if (r.supersedes) supersededIds.add(r.supersedes);
    return list.filter((r) => !supersededIds.has(r.id))[0];
  })();

  const failRelease = (why: string): never => {
    throw new Error(`launch blocked: ${dbProductId}: ${why}`);
  };
  const unreachable = (): never => {
    throw new Error("launch blocked: unreachable");
  };

  const productUrl =
    `${base}/rest/v1/products?id=eq.${encodeURIComponent(dbProductId)}&select=release_sha256`;
  const prodRes = await (async (): Promise<Response> => {
    try {
      return await doFetch(productUrl, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
    } catch (e) {
      failRelease(`release lookup failed: ${(e as Error).message}`);
    }
    return unreachable();
  })();
  if (!prodRes.ok) {
    failRelease(`release lookup HTTP ${prodRes.status}`);
  }
  const productRows = await (async (): Promise<Array<{ release_sha256?: string | null }>> => {
    try {
      return (await prodRes.json()) as Array<{ release_sha256?: string | null }>;
    } catch (e) {
      failRelease(`release lookup returned unparseable body: ${(e as Error).message}`);
    }
    return unreachable();
  })();
  const releaseShaRaw = productRows?.[0]?.release_sha256;
  const releaseSha = typeof releaseShaRaw === "string" ? releaseShaRaw.trim().toLowerCase() : "";
  if (!releaseSha || releaseSha === ZERO_SHA256 || !SHA256_HEX_RE.test(releaseSha)) {
    failRelease(`product has no valid release_sha256 (got ${releaseShaRaw === undefined || releaseShaRaw === null ? "none" : JSON.stringify(releaseShaRaw)})`);
  }
  const approvedRaw = c2Head.document_sha256;
  const approvedSha = typeof approvedRaw === "string" ? approvedRaw.trim().toLowerCase() : "";
  if (!approvedSha || approvedSha === ZERO_SHA256 || !SHA256_HEX_RE.test(approvedSha)) {
    failRelease(`C2 approval ${c2Head.id} has no valid document_sha256`);
  }
  if (approvedSha !== releaseSha) {
    failRelease(
      `C2 approved a different release (approved ${approvedSha}, current ${releaseSha})`,
    );
  }
};
