/**
 * Consent-chain head resolution for the portal (sprint 12 B2, AGY audit P1).
 *
 * Shared SSOT semantics for `/api/billing/checkout` (web/app/api/billing/checkout/route.ts),
 * `assertLaunchConsents` (payments/src/launch_gate.ts), and `portalConsentState`
 * (used by `startPublisherAgreementAction` in web/app/creator/dashboard/actions.ts,
 * the dashboard, and the consent pages): a consent is ACTIVE only when it is the
 * sole HEAD of its supersession chain AND its decision is "given". Superseded
 * rows — including rows superseded by a later refusal — must never read as signed.
 *
 * NOTE: `strictActiveConsentKinds` and `strictChainHead` (below) enforce the
 * single-head rule (`length === 1`), so a fork fails closed on display and gate
 * surfaces alike.
 */

export interface ConsentChainRow {
  id: string;
  kind: string;
  decision: string;
  product_id?: string | null;
  supersedes?: string | null;
  /** Every head this row retired (set supersession, migration 20261115110000).
   *  Absent or empty means the row resolves through `supersedes` alone. */
  supersedes_ids?: string[] | null;
}

/** A supersedes pointer only supersedes when the SUCCESSOR targets the SAME
 *  kind (Cubic P2 on PR #82): a malformed or cross-kind pointer must never lock
 *  a valid consent row.
 *
 *  A row is superseded when a later row names it in `supersedes` OR in
 *  `supersedes_ids` (set supersession: one row can retire every head of a
 *  fork). The same-kind rule applies to both. */
export function supersededConsentIds(consents: ConsentChainRow[]): Set<string> {
  const byId = new Map(consents.map((c) => [c.id, c] as const));
  const supersededIds = new Set<string>();
  for (const c of consents) {
    const pointers: string[] = [];
    if (typeof c.supersedes === "string" && c.supersedes !== "") pointers.push(c.supersedes);
    if (Array.isArray(c.supersedes_ids)) {
      for (const id of c.supersedes_ids) {
        if (typeof id === "string" && id !== "") pointers.push(id);
      }
    }
    for (const id of pointers) {
      const target = byId.get(id);
      if (target && target.kind === c.kind) {
        supersededIds.add(id);
      }
    }
  }
  return supersededIds;
}

/**
 * STRICT gate semantics for money-path enforcement (CR round-2 on PR #85):
 * a kind passes ONLY when it has EXACTLY ONE chain head (`kindHeads.length === 1`)
 * and that head's decision is "given". A concurrent pre-lock race can leave two
 * heads for one kind (one given, one refused). Counting the kind active off the
 * given head alone would authorize a payment, so any ambiguity fails closed (the
 * F6 race lock prevents NEW forks but does not repair existing ones).
 * Enforced here in `strictActiveConsentKinds` and `strictChainHead` (and in SQL by
 * `strict_active_consent_kinds` in supabase/migrations/20261009000000_launch_trigger_and_audit.sql);
 * `startPublisherAgreementAction`, `/api/billing/checkout`, and `assertLaunchConsents`
 * all enforce it through these helpers (or `portalConsentState`). This is the only
 * active-kind resolver.
 */
export function strictActiveConsentKinds(consents: ConsentChainRow[], productId?: string): Set<string> {
  const supersededIds = supersededConsentIds(consents);
  const candidateRows = consents.filter((c) => !supersededIds.has(c.id));
  const scopedHeads = productId ? candidateRows.filter((c) => c.product_id === productId) : candidateRows;

  const active = new Set<string>();
  const kinds = new Set(consents.map((c) => c.kind));
  for (const kind of kinds) {
    const kindHeads = scopedHeads.filter((c) => c.kind === kind);
    if (kindHeads.length === 1 && kindHeads[0].decision === "given") active.add(kind);
  }
  return active;
}


/** The single product-scoped chain head for `kind` (supersession resolved
 *  creator-wide, as above), or null when there are zero or several heads. */
export function strictChainHead<T extends ConsentChainRow>(consents: T[], productId: string, kind: string): T | null {
  const supersededIds = supersededConsentIds(consents);
  const heads = consents.filter((c) => c.kind === kind && c.product_id === productId && !supersededIds.has(c.id));
  return heads.length === 1 ? heads[0] : null;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Lowercased sha256 hex, or null for missing/blank/non-hex/all-zero values. */
export function normalizeSha256(raw: unknown): string | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return SHA256_HEX_RE.test(v) && v !== "0".repeat(64) ? v : null;
}

/** A consent row as the portal reads it (creator-wide, with the approved document hash). */
export interface PortalConsentRow extends ConsentChainRow {
  document_sha256?: string | null;
}

export interface PortalConsentState {
  hasC1: boolean;
  hasC2: boolean;
  hasC3: boolean;
}

/**
 * What the creator portal may show as signed. Uses the SAME rule as
 * /api/billing/checkout so the portal never offers a state the checkout gate
 * would refuse: a kind is signed only when its single strict head (supersession
 * resolved creator-wide, product-scoped) is "given"; C2 additionally requires
 * that head's document hash to equal the product's current release hash.
 * A forked kind (two heads) is never signed; a superseded row is never signed.
 */
export function portalConsentState(
  consents: PortalConsentRow[],
  productId: string,
  releaseSha256: unknown,
): PortalConsentState {
  const active = strictActiveConsentKinds(consents, productId);
  const releaseSha = normalizeSha256(releaseSha256);
  const c2Head = strictChainHead(consents, productId, "C2_release_approval");
  const approvedSha = normalizeSha256(c2Head?.document_sha256);
  const c2ApprovesRelease = releaseSha !== null && approvedSha !== null && approvedSha === releaseSha;
  return {
    hasC1: active.has("C1_data_accuracy"),
    hasC2: active.has("C2_release_approval") && c2ApprovesRelease,
    hasC3: active.has("C3_revenue_split"),
  };
}
