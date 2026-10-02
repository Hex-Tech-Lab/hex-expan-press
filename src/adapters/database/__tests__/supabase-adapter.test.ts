// Regression test for the Wave 6 defect class: webhook routes construct
// their adapters BEFORE the fail-closed HMAC gate runs, so an eagerly-built
// Supabase client turned an unconfigured environment into a pre-auth 500
// that masked signature-validation failures (the 400 contract). The client
// must be created lazily at the point of real DB work — construction with
// no env configured must not throw, and the configuration error must
// surface only when the adapter is actually used.
import { describe, it, expect, vi, afterEach } from "vitest";

const createClientMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: ((...args: unknown[]) => createClientMock(...(args as []))) as never,
}));

import { SupabaseAdapter } from "../supabase.adapter";

describe("SupabaseAdapter lazy client (webhook pre-auth contract)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    createClientMock.mockReset();
  });

  it("constructs with no env configured — signature validation gates first", () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    expect(() => new SupabaseAdapter()).not.toThrow();
    // Construction must not touch the Supabase SDK at all.
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("surfaces the configuration error only when the adapter is actually used", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    createClientMock.mockImplementation(() => {
      throw new Error("supabaseKey is required.");
    });
    const adapter = new SupabaseAdapter();
    await expect(
      adapter.submitConsent({
        productId: "p1",
        userId: "u1",
        kind: "C3_revenue_split",
        decision: "given",
        textVersion: "v1.0",
        documentSha256: "abc",
        typedName: "t",
        ip: "0.0.0.0",
        userAgent: "test",
        authProvider: "firma",
        externalRef: "e1",
        evidencePath: "p",
      }),
    ).rejects.toThrow("supabaseKey is required.");
  });

  it("extracts constraint name from error.message with error.constraint fallback", async () => {
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "secret");
    createClientMock.mockImplementation(() => ({
      rpc: vi.fn(async () => ({
        error: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "consents_kind_external_ref_uidx"',
        },
      })),
    }));
    const adapter = new SupabaseAdapter();
    const err = await adapter.submitConsent({
      productId: "p1",
      userId: "u1",
      kind: "C3_revenue_split",
      decision: "given",
      textVersion: "v1.0",
      documentSha256: "abc",
      typedName: "t",
      ip: "0.0.0.0",
      userAgent: "test",
      authProvider: "firma",
      externalRef: "e1",
      evidencePath: "p",
    }).catch((e: unknown) => e);
    expect((err as { constraint?: string }).constraint).toBe("consents_kind_external_ref_uidx");
  });
});
