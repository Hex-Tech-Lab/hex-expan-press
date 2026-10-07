// Sprint 12 B2 (AGY audit P1, finding 1.1): the portal's consent status
// surfaces must resolve the supersession chain the same way the action and
// the bake path do — a superseded row (or a row superseded by a later
// refusal) must never read as "Signed ✓".
import { describe, it, expect } from "vitest";
import { activeConsentKinds, strictActiveConsentKinds, type ConsentChainRow } from "../consent-chain";

const row = (over: Partial<ConsentChainRow> & { id: string }): ConsentChainRow => ({
  kind: "C2_release_approval",
  decision: "given",
  product_id: "p1",
  supersedes: null,
  ...over,
});

describe("activeConsentKinds — chain-head resolution", () => {
  it("a superseded 'given' row does NOT make the kind active", () => {
    const rows = [
      row({ id: "c2_old", kind: "C2_release_approval", decision: "given" }),
      row({ id: "c2_new", kind: "C2_release_approval", decision: "refused", supersedes: "c2_old" }),
    ];
    expect(activeConsentKinds(rows).has("C2_release_approval")).toBe(false);
  });

  it("a plain superseded-and-replaced chain keeps the kind active only via the given head", () => {
    const rows = [
      row({ id: "c2_v1", decision: "given" }),
      row({ id: "c2_v2", decision: "refused", supersedes: "c2_v1" }),
      row({ id: "c2_v3", decision: "given", supersedes: "c2_v2" }),
    ];
    expect(activeConsentKinds(rows).has("C2_release_approval")).toBe(true);
  });

  it("multi-hop chains mark every non-head row superseded", () => {
    const rows = [
      row({ id: "a", decision: "given" }),
      row({ id: "b", decision: "given", supersedes: "a" }),
      row({ id: "c", decision: "refused", supersedes: "b" }),
    ];
    const active = activeConsentKinds(rows);
    expect(active.has("C2_release_approval")).toBe(false);
  });

  it("independent chains: an active head counts even when another chain ended refused", () => {
    const rows = [
      row({ id: "chain1_head", decision: "refused" }),
      row({ id: "chain2_head", decision: "given" }),
    ];
    expect(activeConsentKinds(rows).has("C2_release_approval")).toBe(true);
  });

  it("product scoping: another product's consent never activates this product", () => {
    const rows = [
      row({ id: "other", product_id: "p2", decision: "given" }),
      row({ id: "mine", product_id: "p1", decision: "refused" }),
    ];
    expect(activeConsentKinds(rows, "p1").has("C2_release_approval")).toBe(false);
    expect(activeConsentKinds(rows, "p2").has("C2_release_approval")).toBe(true);
  });

  it("mixed kinds resolve independently", () => {
    const rows = [
      row({ id: "c1", kind: "C1_data_accuracy", decision: "given" }),
      row({ id: "c2", kind: "C2_release_approval", decision: "refused" }),
      row({ id: "c3", kind: "C3_revenue_split", decision: "given", supersedes: "c2" }),
    ];
    const active = activeConsentKinds(rows);
    expect(active.has("C1_data_accuracy")).toBe(true);
    expect(active.has("C2_release_approval")).toBe(false);
    expect(active.has("C3_revenue_split")).toBe(true);
  });

  it("unconfigured supersedes pointers (null/empty) never mark rows superseded", () => {
    const rows = [
      row({ id: "x", supersedes: null, decision: "given" }),
      row({ id: "y", supersedes: "", decision: "given" }),
    ];
    expect(activeConsentKinds(rows).size).toBe(1); // both rows are same-kind heads → kind active
  });

  it("a CROSS-KIND supersedes pointer never suppresses a valid row (Cubic P2, PR #82)", () => {
    const rows = [
      row({ id: "c2_row", kind: "C2_release_approval", decision: "given" }),
      row({ id: "c3_row", kind: "C3_revenue_split", decision: "given", supersedes: "c2_row" }), // malformed pointer
    ];
    const active = activeConsentKinds(rows);
    expect(active.has("C2_release_approval")).toBe(true); // the C2 row stays active
    expect(active.has("C3_revenue_split")).toBe(true);
  });

  it("a pointer at an id OUTSIDE the resolved scope is not honored", () => {
    const rows = [row({ id: "c2_row", decision: "given", supersedes: "ghost_id" })];
    expect(activeConsentKinds(rows).has("C2_release_approval")).toBe(true);
  });

  it("cross-product supersession: an old consent is NOT active when its successor belongs to another product", () => {
    const rows = [
      row({ id: "c2_old_p1", product_id: "p1", kind: "C2_release_approval", decision: "given" }),
      row({ id: "c2_new_p2", product_id: "p2", kind: "C2_release_approval", decision: "given", supersedes: "c2_old_p1" }),
    ];
    // Under p1, c2_old_p1 has been superseded across the creator's complete chain, so it is not active
    expect(activeConsentKinds(rows, "p1").has("C2_release_approval")).toBe(false);
    // Under p2, c2_new_p2 is the active head
    expect(activeConsentKinds(rows, "p2").has("C2_release_approval")).toBe(true);
  });
});


describe("strictActiveConsentKinds (money-path single-head gate — CR round-2 PR #85)", () => {
  const P = "57596c19-c550-4bde-b17a-e87b86d005c5";
  const row = (id: string, kind: string, decision: string, extra: Partial<{ product_id: string; supersedes: string | null }> = {}) => ({
    id,
    kind,
    decision,
    product_id: extra.product_id ?? P,
    supersedes: extra.supersedes ?? null,
  });

  it("passes a kind with exactly one given head", () => {
    const active = strictActiveConsentKinds([row("a", "C1_data_accuracy", "given")], P);
    expect(active.has("C1_data_accuracy")).toBe(true);
  });

  it("FAILS a kind forked into a given head and a refused head (ambiguous → fail closed)", () => {
    const active = strictActiveConsentKinds(
      [row("a", "C2_release_approval", "given"), row("b", "C2_release_approval", "refused")],
      P,
    );
    expect(active.has("C2_release_approval")).toBe(false);
  });

  it("supersession still collapses chains before the single-head check (successor on another product)", () => {
    const active = strictActiveConsentKinds(
      [
        row("old", "C1_data_accuracy", "given", { product_id: "11111111-1111-1111-1111-111111111111" }),
        row("new", "C1_data_accuracy", "given", { product_id: "22222222-2222-2222-2222-222222222222", supersedes: "old" }),
      ],
      "11111111-1111-1111-1111-111111111111",
    );
    // The old head is superseded creator-wide by the cross-product successor,
    // so the displayed product has ZERO heads → kind is NOT active.
    expect(active.has("C1_data_accuracy")).toBe(false);
  });

  it("a refused single head is not active", () => {
    const active = strictActiveConsentKinds([row("a", "C3_revenue_split", "refused")], P);
    expect(active.has("C3_revenue_split")).toBe(false);
  });
});
