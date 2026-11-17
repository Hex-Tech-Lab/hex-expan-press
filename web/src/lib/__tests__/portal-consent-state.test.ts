// Argon F-15: the creator portal may show a consent as signed only when /api/billing/checkout
// would accept it. These cases pin the portal display rule to the checkout rule: strict single
// chain head, supersession resolved creator-wide before product scoping, and C2 bound to the
// product's current release hash.
import { describe, it, expect } from "vitest";
import { portalConsentState, type PortalConsentRow } from "../consent-chain";

const P = "57596c19-c550-4bde-b17a-e87b86d005c5";
const OTHER = "11111111-1111-1111-1111-111111111111";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const row = (id: string, kind: string, decision: string, extra: Partial<PortalConsentRow> = {}): PortalConsentRow => ({
  id,
  kind,
  decision,
  product_id: P,
  supersedes: null,
  document_sha256: null,
  ...extra,
});

describe("portalConsentState — C2 release hash (F-15: a hash change must show the sign form)", () => {
  it("a C2 approved for an older release hash is not signed once the release hash changes", () => {
    const rows = [row("c2", "C2_release_approval", "given", { document_sha256: SHA_A })];
    expect(portalConsentState(rows, P, SHA_B).hasC2).toBe(false);
  });

  it("a C2 approved for the current release hash is signed", () => {
    const rows = [row("c2", "C2_release_approval", "given", { document_sha256: SHA_A })];
    expect(portalConsentState(rows, P, SHA_A).hasC2).toBe(true);
  });

  it("no release hash, or a zero/invalid one, is never signed (matches checkout's fail-closed check)", () => {
    const rows = [row("c2", "C2_release_approval", "given", { document_sha256: SHA_A })];
    expect(portalConsentState(rows, P, null).hasC2).toBe(false);
    expect(portalConsentState(rows, P, "0".repeat(64)).hasC2).toBe(false);
    expect(portalConsentState(rows, P, "not-a-hash").hasC2).toBe(false);
  });

  it("hash comparison is case-insensitive, as checkout's normalisation is", () => {
    const rows = [row("c2", "C2_release_approval", "given", { document_sha256: SHA_A.toUpperCase() })];
    expect(portalConsentState(rows, P, SHA_A).hasC2).toBe(true);
  });
});

describe("portalConsentState — forked and superseded heads (F-15: resolve to the strict head)", () => {
  it("a forked C2 (given head and refused head, both unsuperseded) is not signed", () => {
    const rows = [
      row("c2_given", "C2_release_approval", "given", { document_sha256: SHA_A }),
      row("c2_refused", "C2_release_approval", "refused", { document_sha256: SHA_A }),
    ];
    expect(portalConsentState(rows, P, SHA_A).hasC2).toBe(false);
  });

  it("a fork collapses to its single strict head once a successor supersedes the sibling", () => {
    const rows = [
      row("c2_old", "C2_release_approval", "given", { document_sha256: SHA_A }),
      row("c2_new", "C2_release_approval", "given", { document_sha256: SHA_B, supersedes: "c2_old" }),
    ];
    expect(portalConsentState(rows, P, SHA_B).hasC2).toBe(true);
    expect(portalConsentState(rows, P, SHA_A).hasC2).toBe(false);
  });
});

describe("portalConsentState — superseded consents are never shown as done", () => {
  it("a C1 given row superseded by a later refusal is not signed", () => {
    const rows = [
      row("c1_old", "C1_data_accuracy", "given"),
      row("c1_new", "C1_data_accuracy", "refused", { supersedes: "c1_old" }),
    ];
    expect(portalConsentState(rows, P, SHA_A).hasC1).toBe(false);
  });

  it("a C3 superseded by a refusal recorded on ANOTHER product is not signed for this product", () => {
    const rows = [
      row("c3_old", "C3_revenue_split", "given"),
      row("c3_new", "C3_revenue_split", "refused", { product_id: OTHER, supersedes: "c3_old" }),
    ];
    expect(portalConsentState(rows, P, SHA_A).hasC3).toBe(false);
  });

  it("a superseded C2 is not signed even when its hash still matches the release", () => {
    const rows = [
      row("c2_old", "C2_release_approval", "given", { document_sha256: SHA_A }),
      row("c2_new", "C2_release_approval", "refused", { document_sha256: SHA_A, supersedes: "c2_old" }),
    ];
    expect(portalConsentState(rows, P, SHA_A).hasC2).toBe(false);
  });

  it("another product's consents never sign this product", () => {
    const rows = [
      row("c1_other", "C1_data_accuracy", "given", { product_id: OTHER }),
      row("c2_other", "C2_release_approval", "given", { product_id: OTHER, document_sha256: SHA_A }),
      row("c3_other", "C3_revenue_split", "given", { product_id: OTHER }),
    ];
    expect(portalConsentState(rows, P, SHA_A)).toEqual({ hasC1: false, hasC2: false, hasC3: false });
  });

  it("a fully signed, current chain reports all three kinds", () => {
    const rows = [
      row("c1", "C1_data_accuracy", "given"),
      row("c2", "C2_release_approval", "given", { document_sha256: SHA_A }),
      row("c3", "C3_revenue_split", "given"),
    ];
    expect(portalConsentState(rows, P, SHA_A)).toEqual({ hasC1: true, hasC2: true, hasC3: true });
  });
});

describe("portalConsentState — set supersession (supersedes_ids: one successor retires a whole fork)", () => {
  it("a C1 fork is signed once a given successor lists both heads", () => {
    const rows = [
      row("c1_a", "C1_data_accuracy", "given"),
      row("c1_b", "C1_data_accuracy", "refused"),
      row("c1_new", "C1_data_accuracy", "given", { supersedes: "c1_b", supersedes_ids: ["c1_a", "c1_b"] }),
    ];
    expect(portalConsentState(rows, P, SHA_A).hasC1).toBe(true);
  });

  it("regression: a successor that lists only one head leaves the other visible, so the fork is not signed", () => {
    const rows = [
      row("c1_a", "C1_data_accuracy", "given"),
      row("c1_b", "C1_data_accuracy", "refused"),
      row("c1_new", "C1_data_accuracy", "given", { supersedes: "c1_a", supersedes_ids: ["c1_a"] }),
    ];
    expect(portalConsentState(rows, P, SHA_A).hasC1).toBe(false);
  });

  it("a C2 fork resolved by a set signs against the new head's hash, not the retired heads'", () => {
    const rows = [
      row("c2_a", "C2_release_approval", "given", { document_sha256: SHA_A }),
      row("c2_b", "C2_release_approval", "refused", { document_sha256: SHA_A }),
      row("c2_new", "C2_release_approval", "given", { document_sha256: SHA_B, supersedes: "c2_b", supersedes_ids: ["c2_a", "c2_b"] }),
    ];
    expect(portalConsentState(rows, P, SHA_B).hasC2).toBe(true);
    expect(portalConsentState(rows, P, SHA_A).hasC2).toBe(false);
  });
});
