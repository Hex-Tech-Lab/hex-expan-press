// Set supersession (consents.supersedes_ids, migration 20261115110000): one new
// row can retire EVERY head of a forked (product, kind). These cases pin the
// TypeScript chain reader; the SQL side is pinned by
// consents-submit-supersedes-set.sql.test.ts and the launch-gate parity test.
import { describe, it, expect } from "vitest";
import {
  strictActiveConsentKinds,
  strictChainHead,
  type ConsentChainRow,
  type PortalConsentRow,
} from "../consent-chain";

const P = "57596c19-c550-4bde-b17a-e87b86d005c5";

const row = (id: string, kind: string, decision: string, extra: Partial<PortalConsentRow> = {}): PortalConsentRow => ({
  id,
  kind,
  decision,
  product_id: P,
  supersedes: null,
  supersedes_ids: [],
  ...extra,
});

describe("set supersession: a fork resolves to one head", () => {
  it("two C1 heads (given and refused) collapse to the new given row that lists both", () => {
    const rows = [
      row("a", "C1_data_accuracy", "given"),
      row("b", "C1_data_accuracy", "refused"),
      row("c", "C1_data_accuracy", "given", { supersedes: "b", supersedes_ids: ["a", "b"] }),
    ];
    expect(strictActiveConsentKinds(rows, P).has("C1_data_accuracy")).toBe(true);
    expect(strictChainHead(rows, P, "C1_data_accuracy")?.id).toBe("c");
  });

  it("the fork stays unresolved without the set (baseline: the strict gate fails closed)", () => {
    const rows = [
      row("a", "C1_data_accuracy", "given"),
      row("b", "C1_data_accuracy", "refused"),
    ];
    expect(strictActiveConsentKinds(rows, P).has("C1_data_accuracy")).toBe(false);
    expect(strictChainHead(rows, P, "C1_data_accuracy")).toBeNull();
  });
});

describe("set supersession: regression, a set naming only one head", () => {
  it("leaves the other head visible, so the fork still fails closed", () => {
    const rows = [
      row("a", "C1_data_accuracy", "given"),
      row("b", "C1_data_accuracy", "refused"),
      row("c", "C1_data_accuracy", "given", { supersedes: "a", supersedes_ids: ["a"] }),
    ];
    // b is not superseded by anyone, so there are two heads (b and c).
    expect(strictChainHead(rows, P, "C1_data_accuracy")).toBeNull();
    expect(strictActiveConsentKinds(rows, P).has("C1_data_accuracy")).toBe(false);
  });

  it("an id that appears only in supersedes_ids supersedes the same way a supersedes pointer does", () => {
    const rows = [
      row("old", "C2_release_approval", "given", { document_sha256: "a".repeat(64) }),
      row("new", "C2_release_approval", "given", { supersedes_ids: ["old"] }),
    ];
    expect(strictChainHead(rows, P, "C2_release_approval")?.id).toBe("new");
  });
});

describe("set supersession: the new row is the strict head", () => {
  it("a given row that retires every head becomes the only head for its kind", () => {
    const rows = [
      row("a", "C2_release_approval", "given", { document_sha256: "a".repeat(64) }),
      row("b", "C2_release_approval", "refused", { document_sha256: "a".repeat(64) }),
      row("c", "C2_release_approval", "given", { document_sha256: "b".repeat(64), supersedes: "b", supersedes_ids: ["a", "b"] }),
    ];
    const head = strictChainHead(rows, P, "C2_release_approval");
    expect(head?.id).toBe("c");
    expect(head?.decision).toBe("given");
  });

  it("a refused row that retires a fork becomes the head, so the kind is not active", () => {
    const rows = [
      row("a", "C3_revenue_split", "given"),
      row("b", "C3_revenue_split", "given"),
      row("c", "C3_revenue_split", "refused", { supersedes: "b", supersedes_ids: ["a", "b"] }),
    ];
    expect(strictChainHead(rows, P, "C3_revenue_split")?.id).toBe("c");
    expect(strictActiveConsentKinds(rows, P).has("C3_revenue_split")).toBe(false);
  });
});

describe("set supersession: safety rules still hold", () => {
  it("a cross-kind entry in supersedes_ids never retires a row of another kind", () => {
    const rows = [
      row("c2", "C2_release_approval", "given", { document_sha256: "a".repeat(64) }),
      row("c3", "C3_revenue_split", "given", { supersedes_ids: ["c2"] }),
    ];
    expect(strictChainHead(rows, P, "C2_release_approval")?.id).toBe("c2");
    expect(strictActiveConsentKinds(rows, P).has("C2_release_approval")).toBe(true);
  });

  it("an id outside the resolved rows in supersedes_ids is ignored", () => {
    const rows = [
      row("a", "C1_data_accuracy", "given", { supersedes_ids: ["ghost"] }),
    ];
    expect(strictChainHead(rows, P, "C1_data_accuracy")?.id).toBe("a");
  });

  it("empty or missing supersedes_ids resolves through the supersedes pointer alone", () => {
    const rows: ConsentChainRow[] = [
      { id: "old", kind: "C1_data_accuracy", decision: "given", product_id: P, supersedes: null },
      { id: "new", kind: "C1_data_accuracy", decision: "refused", product_id: P, supersedes: "old", supersedes_ids: null },
    ];
    expect(strictChainHead(rows, P, "C1_data_accuracy")?.id).toBe("new");
    expect(strictActiveConsentKinds(rows, P).has("C1_data_accuracy")).toBe(false);
  });

  it("a superseded row in another product's chain does not become a head here", () => {
    const OTHER = "11111111-1111-1111-1111-111111111111";
    const rows = [
      row("a", "C1_data_accuracy", "given"),
      row("b", "C1_data_accuracy", "given", { product_id: OTHER, supersedes: "a", supersedes_ids: ["a"] }),
    ];
    // a is retired creator-wide by b (set on another product), so P has no head for C1.
    expect(strictChainHead(rows, P, "C1_data_accuracy")).toBeNull();
  });
});
