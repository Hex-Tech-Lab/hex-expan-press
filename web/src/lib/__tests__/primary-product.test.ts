import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolvePrimaryProduct } from "../primary-product";
import { startPublisherAgreementAction } from "../../../app/creator/dashboard/actions";

// Mock dependencies for startPublisherAgreementAction
const mockCreateEsignEnvelopeUseCase = vi.fn();
vi.mock("../../../../src/adapters/settings/env_settings.adapter", () => ({
  EnvSettingsAdapter: vi.fn(),
}));
vi.mock("../../../../src/use_cases/create_esign_envelope", () => ({
  createEsignEnvelopeUseCase: (...args: unknown[]) => mockCreateEsignEnvelopeUseCase(...args),
}));

let currentPortalSession: { user: { id: string; email: string }; supabase: SupabaseClient } | null = null;
vi.mock("../supabase-server", () => ({
  getPortalSession: vi.fn(async () => currentPortalSession),
  clearPortalCookies: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const err = new Error(`NEXT_REDIRECT:${url}`) as Error & { digest: string };
    err.digest = `NEXT_REDIRECT;${url}`;
    throw err;
  },
  // Mirrors next/navigation: re-throw only Next navigation signals (redirect/notFound).
  unstable_rethrow: (err: unknown) => {
    if (err && typeof err === "object" && "digest" in err) throw err;
  },
}));

describe("resolvePrimaryProduct", () => {
  it("orders by created_at ascending then id ascending and limits to 1", async () => {
    const limitMock = vi.fn().mockResolvedValue({
      data: [{ id: "p1", title: "Book One", created_at: "2026-01-01" }],
      error: null,
    });
    const orderIdMock = vi.fn().mockReturnValue({ limit: limitMock });
    const orderCreatedAtMock = vi.fn().mockReturnValue({ order: orderIdMock });
    const selectMock = vi.fn().mockReturnValue({ order: orderCreatedAtMock });
    const fromMock = vi.fn().mockReturnValue({ select: selectMock });

    const supabase = { from: fromMock } as unknown as SupabaseClient;

    const result = await resolvePrimaryProduct(supabase, "id, title");

    expect(fromMock).toHaveBeenCalledWith("products");
    expect(selectMock).toHaveBeenCalledWith("id, title");
    expect(orderCreatedAtMock).toHaveBeenCalledWith("created_at", { ascending: true });
    expect(orderIdMock).toHaveBeenCalledWith("id", { ascending: true });
    expect(limitMock).toHaveBeenCalledWith(1);
    expect(result).toEqual({
      product: { id: "p1", title: "Book One", created_at: "2026-01-01" },
      error: null,
    });
  });

  it("returns null product and propagates error when supabase fails", async () => {
    const dbError = { message: "connection error" };
    const limitMock = vi.fn().mockResolvedValue({
      data: null,
      error: dbError,
    });
    const orderIdMock = vi.fn().mockReturnValue({ limit: limitMock });
    const orderCreatedAtMock = vi.fn().mockReturnValue({ order: orderIdMock });
    const selectMock = vi.fn().mockReturnValue({ order: orderCreatedAtMock });
    const fromMock = vi.fn().mockReturnValue({ select: selectMock });

    const supabase = { from: fromMock } as unknown as SupabaseClient;

    const result = await resolvePrimaryProduct(supabase, "id");
    expect(result).toEqual({
      product: null,
      error: dbError,
    });
  });

  it("returns null product when data array is empty", async () => {
    const limitMock = vi.fn().mockResolvedValue({
      data: [],
      error: null,
    });
    const orderIdMock = vi.fn().mockReturnValue({ limit: limitMock });
    const orderCreatedAtMock = vi.fn().mockReturnValue({ order: orderIdMock });
    const selectMock = vi.fn().mockReturnValue({ order: orderCreatedAtMock });
    const fromMock = vi.fn().mockReturnValue({ select: selectMock });

    const supabase = { from: fromMock } as unknown as SupabaseClient;

    const result = await resolvePrimaryProduct(supabase, "id");
    expect(result).toEqual({
      product: null,
      error: null,
    });
  });
});

describe("C3 binding (startPublisherAgreementAction)", () => {
  beforeEach(() => {
    mockCreateEsignEnvelopeUseCase.mockReset();
    mockCreateEsignEnvelopeUseCase.mockResolvedValue({ signUrl: "https://firma.example/sign/abc" });
  });

  const setupSupabaseConsents = (consentsData: unknown[] | null, error: unknown = null, primaryProductId: string | null = "prod-new") => {
    const inMock = vi.fn().mockResolvedValue({ data: consentsData, error });
    const eqMock = vi.fn().mockResolvedValue({ data: consentsData, error });
    const selectMock = vi.fn().mockReturnValue({ in: inMock, eq: eqMock });
    const productsChain = {
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: primaryProductId ? [{ id: primaryProductId }] : [], error: null }),
    };
    const fromMock = vi.fn().mockImplementation((table: string) => {
      if (table === "consents") return { select: selectMock };
      if (table === "products") return { select: vi.fn().mockReturnValue(productsChain) };
      throw new Error(`Unexpected table ${table}`);
    });
    const supabase = { from: fromMock } as unknown as SupabaseClient;
    currentPortalSession = {
      user: { id: "user-123", email: "author@example.com" },
      supabase,
    };
    return { fromMock, selectMock, inMock, eqMock };
  };


  it("redirects with c2_required when consents query errors or returns empty", async () => {
    setupSupabaseConsents(null, { message: "query failed" });
    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=c2_required");

    setupSupabaseConsents([]);
    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=c2_required");
  });

  it("redirects with c2_required when there are multiple chain heads (forked)", async () => {
    setupSupabaseConsents([
      { id: "c1", product_id: "prod-1", kind: "C2_release_approval", decision: "given", signed_at: "2026-01-01", supersedes: null },
      { id: "c2", product_id: "prod-2", kind: "C2_release_approval", decision: "given", signed_at: "2026-01-02", supersedes: null },
    ]);
    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=c2_required");
  });

  it("redirects with c2_required when the supersedes-chain head is refused", async () => {
    setupSupabaseConsents([
      { id: "c1", product_id: "prod-1", kind: "C2_release_approval", decision: "given", signed_at: "2026-01-01", supersedes: null },
      { id: "c2", product_id: "prod-1", kind: "C2_release_approval", decision: "refused", signed_at: "2026-01-02", supersedes: "c1" },
    ]);
    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=c2_required");
  });

  it("redirects with c2_required when all rows are superseded (circular/no head)", async () => {
    setupSupabaseConsents([
      { id: "c1", product_id: "prod-1", kind: "C2_release_approval", decision: "given", signed_at: "2026-01-01", supersedes: "c2" },
      { id: "c2", product_id: "prod-1", kind: "C2_release_approval", decision: "given", signed_at: "2026-01-02", supersedes: "c1" },
    ]);
    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=c2_required");
  });

  it("fails closed (c2_required) when the C2 head product is not the primary product every status page reads", async () => {
    setupSupabaseConsents(
      [{ id: "c1", product_id: "prod-other", kind: "C2_release_approval", decision: "given", signed_at: "2026-01-01", supersedes: null }],
      null,
      "prod-primary",
    );
    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:/creator/dashboard?error=c2_required");
    expect(mockCreateEsignEnvelopeUseCase).not.toHaveBeenCalled();
  });

  it("picks the C2 head product and creates envelope when head decision is given", async () => {
    const { selectMock, inMock } = setupSupabaseConsents([
      { id: "c1_data", product_id: "prod-new", kind: "C1_data_accuracy", decision: "given", signed_at: "2026-01-01", supersedes: null },
      { id: "c1", product_id: "prod-old", kind: "C2_release_approval", decision: "given", signed_at: "2026-01-01", supersedes: null },
      { id: "c2", product_id: "prod-new", kind: "C2_release_approval", decision: "given", signed_at: "2026-01-02", supersedes: "c1" },
    ]);

    await expect(startPublisherAgreementAction()).rejects.toThrow("NEXT_REDIRECT:https://firma.example/sign/abc");

    expect(selectMock).toHaveBeenCalledWith("product_id, kind, decision, signed_at, id, supersedes");
    expect(inMock).toHaveBeenCalledWith("kind", ["C1_data_accuracy", "C2_release_approval"]);
    expect(mockCreateEsignEnvelopeUseCase).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "prod-new",
        userId: "user-123",
        userEmail: "author@example.com",
      }),
      expect.anything(),
    );
  });

});
