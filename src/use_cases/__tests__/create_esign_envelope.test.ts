import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SettingsRegistryPort } from "../../domain/settings/settings.port.ts";

const mockCreateEnvelope = vi.hoisted(() => vi.fn());
const mockGetSupabaseAdmin = vi.hoisted(() => vi.fn());

vi.mock("../../../payments/src/supabase_admin.ts", () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}));

vi.mock("../../adapters/esign/esign.factory.ts", () => ({
  createEsignAdapter: () => ({
    createEnvelope: (...args: unknown[]) => mockCreateEnvelope(...args),
  }),
}));

import { createEsignEnvelopeUseCase } from "../create_esign_envelope.ts";

describe("createEsignEnvelopeUseCase — unconfigured Supabase admin client guard", () => {
  const settingsRegistry: SettingsRegistryPort = {
    getPortalSettings: vi.fn().mockResolvedValue({
      esign: {
        strategy: { mode: "2d", distribution: [{ provider: "firma", weight: 100 }], fallbacks: [] },
        revenueSplitDocumentPath: "agreements/revenue_split.pdf",
      },
      payments: {
        checkoutStrategy: { mode: "single", distribution: [{ provider: "paddle", weight: 100 }], fallbacks: [] },
      },
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateEnvelope.mockResolvedValue({
      envelopeId: "env_fallback",
      signUrl: "https://app.firma.test/signing/fallback",
    });
  });

  it("throws when getSupabaseAdmin() returns null and does not silently succeed", async () => {
    mockGetSupabaseAdmin.mockResolvedValueOnce(null);

    await expect(
      createEsignEnvelopeUseCase(
        {
          productId: "prod_1",
          userId: "user_1",
          userEmail: "creator@example.com",
          hostUrl: "https://expanpress.com",
        },
        settingsRegistry
      )
    ).rejects.toThrow(/service-role Supabase client unconfigured/);

    expect(mockCreateEnvelope).not.toHaveBeenCalled();
  });
});
