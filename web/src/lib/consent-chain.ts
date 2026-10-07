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
 *  one product) carries decision "given".
 *
 *  Resolves supersession across the creator's *complete* chain first, and
 *  only *then* filters the active heads to the displayed product. This
 *  prevents an old consent from being marked active when its successor
 *  belongs to another product.
 *
 *  A supersedes pointer only supersedes when the SUCCESSOR targets the SAME
 *  kind (Cubic P2 on PR #82): a malformed or cross-kind pointer must never lock
 *  a valid consent row. */
export function supersededConsentIds(consents: ConsentChainRow[]): Set<string> {
  const byId = new Map(consents.map((c) => [c.id, c] as const));
  const supersededIds = new Set<string>();
  for (const c of consents) {
    if (typeof c.supersedes !== "string" || c.supersedes === "") continue;
    const target = byId.get(c.supersedes);
    if (target && target.kind === c.kind) {
      supersededIds.add(c.supersedes);
    }
  }
  return supersededIds;
}

export function activeConsentKinds(consents: ConsentChainRow[], productId?: string): Set<string> {
  const supersededIds = supersededConsentIds(consents);

  // Chain heads repo-wide (not superseded by any newer same-kind row)
  const candidateRows = consents.filter((c) => !supersededIds.has(c.id));
  const scopedHeads = productId ? candidateRows.filter((c) => c.product_id === productId) : candidateRows;

  const active = new Set<string>();
  for (const c of scopedHeads) {
    if (c.decision === "given") active.add(c.kind);
  }
  return active;
}

/**
 * STRICT gate semantics for money-path enforcement (CR round-2 on PR #85):
 * a kind passes ONLY when it has EXACTLY ONE chain head and that head's
 * decision is "given". A concurrent pre-lock race can leave two heads for one
 * kind (one given, one refused) — the permissive resolver above counts the
 * kind as active off the given head alone, which is correct for DISPLAY but
 * must never authorize a payment: the checkout gate uses this resolver so any
 * ambiguity fails closed (the F6 race lock prevents NEW forks but does not
 * repair existing ones). `startPublisherAgreementAction` already enforces the
 * same single-head rule via its length!==1 checks.
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

