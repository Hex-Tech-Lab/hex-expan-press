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


const createEnvelopeMock = vi.fn().mockResolvedValue({ signUrl: "https://firma.im/sign/envelope_123" });

vi.mock("../../../../../src/use_cases/create_esign_envelope", () => ({
  createEsignEnvelopeUseCase: vi.fn((...args) => createEnvelopeMock(...args)),
}));

vi.mock("../../../../src/lib/supabase-server", () => ({
  getPortalSession: vi.fn(async () => ({
    user: { id: "u1", email: "creator@expanpress.com" },
    supabase: {
      from: (table: string) => {
        if (table === "consents") {
          return {
            select: () => ({
              in: async () => ({
                data: consentsData,
                error: consentsError,
              }),
            }),
          };
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
    consentsError = null;
    consentsData = [];
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
});
