import { describe, it, expect, vi, beforeEach } from "vitest";

const productSelect = {
  select: vi.fn(() => ({
    order: vi.fn(() => ({
      limit: vi.fn(async () => ({ data: [{ id: "p1" }] })),
    })),
  })),
};

interface ConsentTestRow {
  id: string;
  product_id?: string | null;
  kind: string;
  decision: string;
  signed_at?: string | null;
  supersedes?: string | null;
}

let consentsData: ConsentTestRow[] = [];
let consentsError: { message: string } | null = null;

const getUserMock = vi.fn<
  () => Promise<{ data: { user: { id: string; email: string } | null }; error: { message: string } | null }>
>(async () => ({
  data: { user: { id: "u1", email: "creator@expanpress.com" } },
  error: null,
}));

const createEnvelopeMock = vi.fn().mockResolvedValue({ signUrl: "https://firma.im/sign/envelope_123" });

vi.mock("../../../../../src/use_cases/create_esign_envelope", () => ({
  createEsignEnvelopeUseCase: vi.fn((...args) => createEnvelopeMock(...args)),
}));

vi.mock("../../../../src/lib/supabase-server", () => ({
  getPortalSession: vi.fn(async () => ({
    user: { id: "u1", email: "creator@expanpress.com" },
    supabase: {
      auth: {
        getUser: getUserMock,
      },
      from: (table: string) => {
        if (table === "consents") {
          let rows = [...consentsData];
          const query = {
            select: () => query,
            eq: (col: string, val: unknown) => {
              rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[col] === val);
              return query;
            },
            in: (col: string, vals: unknown[]) => {
              rows = rows.filter((r) => vals.includes((r as unknown as Record<string, unknown>)[col]));
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
            limit: async () => ({
              data: consentsError ? null : rows,
              error: consentsError,
            }),
          };
          return query;
        }
        if (table === "products") {
          return productSelect;
        }
        return {};
      },
    },
  })),
  clearPortalCookies: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  unstable_rethrow: (err: unknown) => {
    if (err instanceof Error && err.message.startsWith("NEXT_REDIRECT:")) throw err;
  },
}));

import { startPublisherAgreementAction } from "../actions";

describe("startPublisherAgreementAction — complete consent prerequisite chain (P1)", () => {
  beforeEach(() => {
    createEnvelopeMock.mockClear();
    getUserMock.mockReset();
    getUserMock.mockResolvedValue({
      data: { user: { id: "u1", email: "creator@expanpress.com" } },
      error: null,
    });
    consentsError = null;
    consentsData = [];
  });

  it("fails closed and redirects to signin when online supabase.auth.getUser() reports a revoked session", async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: { message: "session revoked" } });
    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/signin");
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("fails closed and redirects with error=c2_required when consents query fails or is empty", async () => {
    consentsData = [];
    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=c2_required");
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("fails closed when C2 is given but C1 is missing (chain bypass attempt)", async () => {
    consentsData = [
      {
        id: "c2_1",
        product_id: "p1",
        kind: "C2_release_approval",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
    ];
    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=c2_required");
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("fails closed when C1 is given but C2 is missing", async () => {
    consentsData = [
      {
        id: "c1_1",
        product_id: "p1",
        kind: "C1_data_accuracy",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
    ];
    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=c2_required");
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("fails closed when C1 head is refused", async () => {
    consentsData = [
      {
        id: "c1_1",
        product_id: "p1",
        kind: "C1_data_accuracy",
        decision: "refused",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
      {
        id: "c2_1",
        product_id: "p1",
        kind: "C2_release_approval",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
    ];
    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=c2_required");
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("fails closed when C2 was superseded by a refusal", async () => {
    consentsData = [
      {
        id: "c1_1",
        product_id: "p1",
        kind: "C1_data_accuracy",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
      {
        id: "c2_old",
        product_id: "p1",
        kind: "C2_release_approval",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
      {
        id: "c2_new",
        product_id: "p1",
        kind: "C2_release_approval",
        decision: "refused",
        signed_at: "2026-10-02T00:00:00Z",
        supersedes: "c2_old",
      },
    ];
    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=c2_required");
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });

  it("does not let a cross-kind supersede pointer invalidate a valid head (shared same-kind guard)", async () => {
    consentsData = [
      {
        id: "c1_1",
        product_id: "p1",
        kind: "C1_data_accuracy",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
      {
        // Malformed cross-kind pointer: a C2 row pointing at a C1 row must
        // NOT remove the C1 head — same semantics as activeConsentKinds.
        id: "c2_1",
        product_id: "p1",
        kind: "C2_release_approval",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: "c1_1",
      },
    ];

    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:https://firma.im/sign/envelope_123");
    expect(createEnvelopeMock).toHaveBeenCalled();
  });

  it("mints Firma envelope and redirects to signUrl when BOTH C1 AND C2 are active on the primary product", async () => {
    consentsData = [
      {
        id: "c1_1",
        product_id: "p1",
        kind: "C1_data_accuracy",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
      {
        id: "c2_1",
        product_id: "p1",
        kind: "C2_release_approval",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
    ];

    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:https://firma.im/sign/envelope_123");
    expect(createEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "p1",
        userId: "u1",
        userEmail: "creator@expanpress.com",
      }),
      expect.anything(),
    );
  });

  it("scopes consents strictly to primary product and ignores active heads on other products (multi-product isolation)", async () => {
    consentsData = [
      // Product 1 (primary) valid heads
      {
        id: "c1_p1",
        product_id: "p1",
        kind: "C1_data_accuracy",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
      {
        id: "c2_p1",
        product_id: "p1",
        kind: "C2_release_approval",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
      // Product 2 (secondary) extra active heads that would contaminate unscoped query
      {
        id: "c1_p2",
        product_id: "p2",
        kind: "C1_data_accuracy",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
      {
        id: "c2_p2",
        product_id: "p2",
        kind: "C2_release_approval",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: null,
      },
    ];

    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:https://firma.im/sign/envelope_123");
    expect(createEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "p1",
        userId: "u1",
        userEmail: "creator@expanpress.com",
      }),
      expect.anything(),
    );
  });

  it("throws PostgREST 400 if consents query attempts to order by created_at", async () => {
    const session = await (await import("../../../../src/lib/supabase-server")).getPortalSession();
    expect(session).not.toBeNull();
    const query = session!.supabase.from("consents").select("*");
    expect(() => (query as unknown as { order: (col: string) => void }).order("created_at")).toThrow(
      "PostgREST 400: column consents.created_at does not exist",
    );
  });

  it("proves a creator with 500 valid consent records succeeds (paginated properly, no false lockout)", async () => {
    // 1 active C1 head, 1 active C2 head, and 498 older superseded records (249 for C1, 249 for C2)
    const records: ConsentTestRow[] = [
      {
        id: "c1_head",
        product_id: "p1",
        kind: "C1_data_accuracy",
        decision: "given",
        signed_at: "2026-10-15T00:00:00Z",
        supersedes: "c1_old_0",
      },
      {
        id: "c2_head",
        product_id: "p1",
        kind: "C2_release_approval",
        decision: "given",
        signed_at: "2026-10-15T00:00:00Z",
        supersedes: "c2_old_0",
      },
    ];

    for (let i = 0; i < 249; i++) {
      records.push({
        id: `c1_old_${i}`,
        product_id: "p1",
        kind: "C1_data_accuracy",
        decision: "given",
        signed_at: `2026-10-01T00:00:00.${String(i).padStart(3, "0")}Z`,
        supersedes: i < 248 ? `c1_old_${i + 1}` : null,
      });
      records.push({
        id: `c2_old_${i}`,
        product_id: "p1",
        kind: "C2_release_approval",
        decision: "given",
        signed_at: `2026-10-01T00:00:00.${String(i).padStart(3, "0")}Z`,
        supersedes: i < 248 ? `c2_old_${i + 1}` : null,
      });
    }

    expect(records.length).toBe(500);
    consentsData = records;

    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:https://firma.im/sign/envelope_123");
    expect(createEnvelopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "p1",
        userId: "u1",
        userEmail: "creator@expanpress.com",
      }),
      expect.anything(),
    );
  });

  it("fails closed when safety cap of 5,000 rows is reached", async () => {
    // 5,000 valid records (hits safety cap)
    const records: ConsentTestRow[] = [
      {
        id: "c1_head",
        product_id: "p1",
        kind: "C1_data_accuracy",
        decision: "given",
        signed_at: "2026-10-15T00:00:00Z",
        supersedes: "c1_old_0",
      },
      {
        id: "c2_head",
        product_id: "p1",
        kind: "C2_release_approval",
        decision: "given",
        signed_at: "2026-10-15T00:00:00Z",
        supersedes: "c2_old_0",
      },
    ];

    for (let i = 0; i < 2499; i++) {
      records.push({
        id: `c1_old_${i}`,
        product_id: "p1",
        kind: "C1_data_accuracy",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: i < 2498 ? `c1_old_${i + 1}` : null,
      });
      records.push({
        id: `c2_old_${i}`,
        product_id: "p1",
        kind: "C2_release_approval",
        decision: "given",
        signed_at: "2026-10-01T00:00:00Z",
        supersedes: i < 2498 ? `c2_old_${i + 1}` : null,
      });
    }

    expect(records.length).toBe(5000);
    consentsData = records;

    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=c2_required");
    expect(createEnvelopeMock).not.toHaveBeenCalled();
  });
});

