/**
 * Consent-chain head resolution for the portal (sprint 12 B2, AGY audit P1).
 *
 * Mirrors the SSOT semantics of `startPublisherAgreementAction`
 * (web/app/creator/dashboard/actions.ts) and `assertLaunchConsents`
 * (payments/bake_checkout.ts): a consent is ACTIVE only when it is the HEAD
 * of its supersession chain AND its decision is "given". Superseded rows —
 * including rows superseded by a later refusal — must never read as signed.
 *
 * NOTE: this function intentionally does NOT enforce the single-head rule
 * (two independent chains for one kind can both be active). Display surfaces
 * show what the data says; the ACTION/bake paths keep their fail-closed
 * single-head enforcement.
 */

export interface ConsentChainRow {
  id: string;
  kind: string;
  decision: string;
  product_id?: string | null;
  supersedes?: string | null;
}

/** Kinds whose current chain head (within the given rows, optionally scoped to
 *  one product) carries decision "given". A supersedes pointer only supersedes
 *  when the SUCCESSOR targets the SAME kind in the SAME product (Cubic P2 on
 *  PR #82): a malformed or cross-kind/cross-product pointer must never lock a
 *  valid consent row. A pointer at an id outside the scope is likewise not
 *  honored (cannot be verified). */
export function activeConsentKinds(consents: ConsentChainRow[], productId?: string): Set<string> {
  const scoped = productId ? consents.filter((c) => c.product_id === productId) : consents;
  const byId = new Map(scoped.map((c) => [c.id, c] as const));
  const supersededIds = new Set<string>();
  for (const c of scoped) {
    if (typeof c.supersedes !== "string" || c.supersedes === "") continue;
    const target = byId.get(c.supersedes);
    if (target && target.kind === c.kind && target.product_id === c.product_id) {
      supersededIds.add(c.supersedes);
    }
  }
  const active = new Set<string>();
  for (const c of scoped) {
    if (supersededIds.has(c.id)) continue; // locked by a newer same-kind row — never "signed"
    if (c.decision === "given") active.add(c.kind);
  }
  return active;
}
