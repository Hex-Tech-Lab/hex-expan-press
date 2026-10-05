// Sprint 12 B2 (AGY audit P1, finding 1.1): the portal's consent status
// surfaces must resolve the supersession chain the same way the action and
// the bake path do — a superseded row (or a row superseded by a later
// refusal) must never read as "Signed ✓".
import { describe, it, expect } from "vitest";
import { activeConsentKinds, type ConsentChainRow } from "../consent-chain";

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
});
