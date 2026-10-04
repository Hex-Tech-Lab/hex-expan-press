// AUDIT 2026-10-02 (F5): Firma HMAC has no timestamp and consents had no
// unique (kind, external_ref) — a replayed envelope wrote a second C3 row.
// Fix: unique index consents_kind_external_ref_uidx (migration 20261002000000)
// rejects the replay with 23505; the use case acknowledges it instead of failing.
import { describe, it, expect, vi } from "vitest";

vi.mock("../../adapters/esign/esign.factory.ts", () => ({
  createEsignAdapter: () => ({
    parseAndValidateWebhook: () => ({
      isValid: true, providerName: "firma",
      event: { eventType: "envelope.completed", envelopeId: "env_1", documentHash: "a".repeat(64),
               metadata: { productId: "p1", userId: "u1" } },
    }),
  }),
}));

// Models the DB: one row per (kind, external_ref); a repeat raises SQLSTATE 23505.
function uniqueConsentDb() {
  const rows = new Set<string>();
  return {
    rows,
    flagConsentForManualReview: vi.fn(async () => {}),
    submitConsent: vi.fn(async (c: { kind: string; externalRef?: string }) => {
      const key = `${c.kind}:${c.externalRef}`;
      if (rows.has(key)) {
        throw Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint: "consents_kind_external_ref_uidx",
        });
      }
      rows.add(key);
    }),
  };
}

const settings = { getPortalSettings: async () => ({ esign: {} }) };
const req = { body: "{}", headers: {}, ip: "1.1.1.1", userAgent: "ua" };

describe("F5 esign replay", () => {
  it("records one C3 consent per envelope and acknowledges the replay", async () => {
    const { processEsignWebhookUseCase } = await import("../process_esign_webhook.ts");
    const db = uniqueConsentDb();
    await processEsignWebhookUseCase(req, settings as never, db as never);
    await expect(processEsignWebhookUseCase(req, settings as never, db as never)).resolves.toBeUndefined();
    expect(db.rows.size).toBe(1);
  });

  it("acknowledges replay with 200 and logs info when constraint is consents_kind_external_ref_uidx", async () => {
    const { processEsignWebhookUseCase } = await import("../process_esign_webhook.ts");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const err = Object.assign(new Error("unique constraint violated"), {
      code: "23505",
      constraint: "consents_kind_external_ref_uidx",
    });
    const db = { submitConsent: vi.fn(async () => { throw err; }), flagConsentForManualReview: vi.fn(async () => {}) };
    await expect(processEsignWebhookUseCase(req, settings as never, db as never)).resolves.toBeUndefined();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("env_1"));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("C3_revenue_split"));
    infoSpy.mockRestore();
  });

  it("throws retryable error (500) when 23505 is on a different constraint", async () => {
    const { processEsignWebhookUseCase } = await import("../process_esign_webhook.ts");
    const err = Object.assign(new Error("duplicate other constraint"), {
      code: "23505",
      constraint: "consents_pkey",
    });
    const db = { submitConsent: vi.fn(async () => { throw err; }), flagConsentForManualReview: vi.fn(async () => {}) };
    await expect(processEsignWebhookUseCase(req, settings as never, db as never)).rejects.toThrow(/duplicate other constraint/);
  });

  it("still fails on any other database error", async () => {
    const { processEsignWebhookUseCase } = await import("../process_esign_webhook.ts");
    const db = { submitConsent: vi.fn(async () => { throw Object.assign(new Error("boom"), { code: "XX000" }); }) };
    await expect(processEsignWebhookUseCase(req, settings as never, db as never)).rejects.toThrow(/boom/);
  });
});
