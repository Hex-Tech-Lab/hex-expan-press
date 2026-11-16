import { describe, it, expect, vi, beforeEach } from "vitest";

const RELEASE_SHA = "a".repeat(64);
const STALE_SHA = "b".repeat(64);

interface ConsentTestRow {
  id: string;
  product_id?: string | null;
  creator_id?: string;
  kind: string;
  decision: string;
  signed_at?: string | null;
  supersedes?: string | null;
  document_sha256?: string | null;
}

let consentsData: ConsentTestRow[] = [];
let consentsError: { message: string } | null = null;
let productError: { message: string } | null = null;
let productRow: { id: string; creator_id: string | null; release_sha256: string | null } = {
  id: "p1",
  creator_id: "cr1",
  release_sha256: RELEASE_SHA,
};

const sentryCaptureMock = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({
  captureException: sentryCaptureMock,
}));

const createEnvelopeMock = vi.fn().mockResolvedValue({ signUrl: "https://firma.im/sign/envelope_123" });

vi.mock("../../../../../src/use_cases/create_esign_envelope", () => ({
  createEsignEnvelopeUseCase: vi.fn((...args) => createEnvelopeMock(...args)),
}));

vi.mock("../../../../src/lib/supabase-server", () => ({
  getVerifiedPortalSession: vi.fn(async () => ({
    user: { id: "u1", email: "creator@expanpress.com" },
    supabase: {
      from: (table: string) => {
        if (table === "consents") return consentsQuery();
        if (table === "products") {
          return {
            select: () => ({
              order: () => ({
                limit: async () => ({
                  data: productError ? null : [productRow],
                  error: productError,
                }),
              }),
            }),
          };
        }
        return {};
      },
    },
  })),
  clearPortalCookies: vi.fn(),
}));

/** Mirrors the consents reads: eq / order / range. The creator defaults to cr1 for every fixture row. */
function consentsQuery() {
  let rows = consentsData.map((r) => ({ creator_id: "cr1", ...r }) as Record<string, unknown>);
  const query = {
    select: () => query,
    eq: (col: string, val: unknown) => {
      rows = rows.filter((r) => r[col] === val);
      return query;
    },
    order: (col: string) => {
      if (col === "created_at") {
        throw new Error("PostgREST 400: column consents.created_at does not exist");
      }
      return query;
    },
    range: async (from: number, to: number) => ({
      data: consentsError ? null : rows.slice(from, to + 1),
      error: consentsError,
    }),
  };
  return query;
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  unstable_rethrow: (err: unknown) => {
    if (err instanceof Error && err.message.startsWith("NEXT_REDIRECT:")) throw err;
  },
}));

import { startPublisherAgreementAction } from "../actions";
import { getVerifiedPortalSession } from "../../../../src/lib/supabase-server";

const SIGNIN = "NEXT_REDIRECT:/creator/signin";
const C2_REQUIRED = "NEXT_REDIRECT:/creator/dashboard?error=c2_required";
const ENVELOPE = "NEXT_REDIRECT:https://firma.im/sign/envelope_123";

function c1(id: string, extra: Partial<ConsentTestRow> = {}): ConsentTestRow {
  return {
    id,
    product_id: "p1",
    kind: "C1_data_accuracy",
    decision: "given",
    signed_at: "2026-10-01T00:00:00Z",
    supersedes: null,
    ...extra,
  };
}

function c2(id: string, extra: Partial<ConsentTestRow> = {}): ConsentTestRow {
  return {
    id,
    product_id: "p1",
    kind: "C2_release_approval",
    decision: "given",
    signed_at: "2026-10-01T00:00:00Z",
    supersedes: null,
    document_sha256: RELEASE_SHA,
    ...extra,
  };
}

describe("startPublisherAgreementAction — complete consent prerequisite chain (P1)", () => {
  beforeEach(() => {
    createEnvelopeMock.mockClear();
    sentryCaptureMock.mockClear();
    consentsError = null;
    productError = null;
    consentsData = [];
    productRow = { id: "p1", creator_id: "cr1", release_sha256: RELEASE_SHA };
  });

  it("fails closed and redirects to signin when the session is revoked (getVerifiedPortalSession refuses)", async () => {
    vi.mocked(getVerifiedPortalSession).mockResolvedValueOnce(null);
    consentsData = [c1("c1_1"), c2("c2_1")];
    await expect(startPublisherAgreementAction()).rejects.toThrow(SIGNIN);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("verifies the session with the explicit-token helper and mints the envelope when C1 and C2 are active", async () => {
    consentsData = [c1("c1_1"), c2("c2_1")];
    await expect(startPublisherAgreementAction()).rejects.toThrow(ENVELOPE);
    expect(getVerifiedPortalSession).toHaveBeenCalled();
    expect(createEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "p1", userId: "u1", userEmail: "creator@expanpress.com" }),
      expect.anything(),
    );
  });

  it("does not skip to launch when the C2 head's document_sha256 is stale (not the product's current release)", async () => {
    consentsData = [c1("c1_1"), c2("c2_1", { document_sha256: STALE_SHA })];
    await expect(startPublisherAgreementAction()).rejects.toThrow(C2_REQUIRED);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("fails closed when the product has no release hash to bind C2 to", async () => {
    productRow = { id: "p1", creator_id: "cr1", release_sha256: null };
    consentsData = [c1("c1_1"), c2("c2_1")];
    await expect(startPublisherAgreementAction()).rejects.toThrow(C2_REQUIRED);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("fails closed and redirects with error=c2_required when consents query fails or is empty", async () => {
    consentsData = [];
    await expect(startPublisherAgreementAction()).rejects.toThrow(C2_REQUIRED);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("fails closed and logs/captures when the primary product read errors", async () => {
    productError = { message: "products timeout" };
    consentsData = [c1("c1_1"), c2("c2_1")];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(startPublisherAgreementAction()).rejects.toThrow(C2_REQUIRED);
      expect(createEnvelopeMock).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith("[dashboard] products query failed:", "products timeout");
      expect(sentryCaptureMock).toHaveBeenCalledWith(productError, {
        tags: { surface: "dashboard", query: "products" },
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("fails closed when the consents read errors and logs/captures the error", async () => {
    consentsError = { message: "permission denied for table consents" };
    consentsData = [c1("c1_1"), c2("c2_1")];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(startPublisherAgreementAction()).rejects.toThrow(C2_REQUIRED);
      expect(createEnvelopeMock).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[dashboard] consents query failed:",
        "permission denied for table consents",
      );
      expect(sentryCaptureMock).toHaveBeenCalledWith(consentsError, {
        tags: { surface: "dashboard", query: "consents" },
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("fails closed when C2 is given but C1 is missing (chain bypass attempt)", async () => {
    consentsData = [c2("c2_1")];
    await expect(startPublisherAgreementAction()).rejects.toThrow(C2_REQUIRED);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("fails closed when C1 is given but C2 is missing", async () => {
    consentsData = [c1("c1_1")];
    await expect(startPublisherAgreementAction()).rejects.toThrow(C2_REQUIRED);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("fails closed when C1 head is refused", async () => {
    consentsData = [c1("c1_1", { decision: "refused" }), c2("c2_1")];
    await expect(startPublisherAgreementAction()).rejects.toThrow(C2_REQUIRED);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("fails closed when C2 was superseded by a refusal", async () => {
    consentsData = [
      c1("c1_1"),
      c2("c2_old"),
      c2("c2_new", { decision: "refused", signed_at: "2026-10-02T00:00:00Z", supersedes: "c2_old" }),
    ];
    await expect(startPublisherAgreementAction()).rejects.toThrow(C2_REQUIRED);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("fails closed when C2 has a fork (two live heads for one kind)", async () => {
    consentsData = [c1("c1_1"), c2("c2_a"), c2("c2_b", { signed_at: "2026-10-02T00:00:00Z" })];
    await expect(startPublisherAgreementAction()).rejects.toThrow(C2_REQUIRED);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("treats a C2 superseded by a sibling product's row of the same creator as retired (creator-wide chain)", async () => {
    consentsData = [
      c1("c1_1"),
      c2("c2_p1"),
      c2("c2_p2", { product_id: "p2", decision: "refused", signed_at: "2026-10-02T00:00:00Z", supersedes: "c2_p1" }),
    ];
    await expect(startPublisherAgreementAction()).rejects.toThrow(C2_REQUIRED);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("does not let a cross-kind supersede pointer invalidate a valid head (shared same-kind guard)", async () => {
    consentsData = [
      c1("c1_1"),
      // Malformed cross-kind pointer: a C2 row pointing at a C1 row must NOT remove the C1 head.
      c2("c2_1", { supersedes: "c1_1" }),
    ];
    await expect(startPublisherAgreementAction()).rejects.toThrow(ENVELOPE);
    expect(createEnvelopeMock).toHaveBeenCalled();
  });

  it("scopes consents strictly to primary product and ignores active heads on other products (multi-product isolation)", async () => {
    consentsData = [
      c1("c1_p1"),
      c2("c2_p1"),
      c1("c1_p2", { product_id: "p2" }),
      c2("c2_p2", { product_id: "p2" }),
    ];
    await expect(startPublisherAgreementAction()).rejects.toThrow(ENVELOPE);
    expect(createEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "p1", userId: "u1", userEmail: "creator@expanpress.com" }),
      expect.anything(),
    );
  });

  it("never orders consents by created_at (the column does not exist): the action completes the chain on signed_at and redirects to the signUrl", async () => {
    // The mocked order("created_at") throws a PostgREST 400. Reaching the redirect proves the
    // action issued only signed_at/id ordering, so the 400 path is never taken.
    consentsData = [c1("c1_1"), c2("c2_1")];
    await expect(startPublisherAgreementAction()).rejects.toThrow(ENVELOPE);
    expect(createEnvelopeMock).toHaveBeenCalledTimes(1);
  });

  it("proves a creator with 500 valid consent records succeeds (paginated properly, no false lockout)", async () => {
    // 1 active C1 head, 1 active C2 head, and 498 older superseded records (249 for C1, 249 for C2)
    const records: ConsentTestRow[] = [
      c1("c1_head", { signed_at: "2026-10-15T00:00:00Z", supersedes: "c1_old_0" }),
      c2("c2_head", { signed_at: "2026-10-15T00:00:00Z", supersedes: "c2_old_0" }),
    ];

    for (let i = 0; i < 249; i++) {
      const signed_at = `2026-10-01T00:00:00.${String(i).padStart(3, "0")}Z`;
      records.push(c1(`c1_old_${i}`, { signed_at, supersedes: i < 248 ? `c1_old_${i + 1}` : null }));
      records.push(c2(`c2_old_${i}`, { signed_at, supersedes: i < 248 ? `c2_old_${i + 1}` : null }));
    }

    expect(records.length).toBe(500);
    consentsData = records;

    await expect(startPublisherAgreementAction()).rejects.toThrow(ENVELOPE);
    expect(createEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({ productId: "p1", userId: "u1", userEmail: "creator@expanpress.com" }),
      expect.anything(),
    );
  });

  it("fails closed when safety cap of 5,000 rows is reached", async () => {
    // 5,000 valid records (hits safety cap)
    const records: ConsentTestRow[] = [
      c1("c1_head", { signed_at: "2026-10-15T00:00:00Z", supersedes: "c1_old_0" }),
      c2("c2_head", { signed_at: "2026-10-15T00:00:00Z", supersedes: "c2_old_0" }),
    ];

    for (let i = 0; i < 2499; i++) {
      records.push(c1(`c1_old_${i}`, { supersedes: i < 2498 ? `c1_old_${i + 1}` : null }));
      records.push(c2(`c2_old_${i}`, { supersedes: i < 2498 ? `c2_old_${i + 1}` : null }));
    }

    expect(records.length).toBe(5000);
    consentsData = records;

    await expect(startPublisherAgreementAction()).rejects.toThrow(C2_REQUIRED);
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("redirects to ?error=credits when envelope creation fails due to insufficient credits", async () => {
    consentsData = [c1("c1_p1"), c2("c2_p1")];
    createEnvelopeMock.mockRejectedValueOnce(new Error("All configured esign providers failed: Insufficient credits. Please purchase more credits to send signing requests."));

    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=credits");
  });

  it("redirects to ?error=credits when envelope creation fails with 402 status code", async () => {
    consentsData = [c1("c1_p1"), c2("c2_p1")];
    createEnvelopeMock.mockRejectedValueOnce(new Error("Esign creation failed", { cause: new Error("Firma returned 402") }));

    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=credits");
  });

  it("redirects to ?error=credits when a fallback provider in an AggregateError reports insufficient credits", async () => {
    consentsData = [c1("c1_p1"), c2("c2_p1")];
    const aggregate = new AggregateError(
      [new Error("Primary network timeout"), new Error("Fallback firma: Insufficient credits")],
      "All configured esign providers failed"
    );
    createEnvelopeMock.mockRejectedValueOnce(new Error("All configured esign providers failed", { cause: aggregate }));

    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=credits");
  });

  it("redirects to ?error=esign when envelope creation fails with a generic error", async () => {
    consentsData = [c1("c1_p1"), c2("c2_p1")];
    createEnvelopeMock.mockRejectedValueOnce(new Error("Connection timeout"));

    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=esign");
  });
});
