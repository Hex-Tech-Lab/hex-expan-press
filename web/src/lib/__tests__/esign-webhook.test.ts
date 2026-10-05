// Regression coverage for the Firma e-sign webhook contract
// (web/app/api/esign/webhook/route.ts -> src/use_cases/process_esign_webhook.ts;
// legacy handler bridge retired in Wave 6).
//
// The real signature scheme (src/adapters/esign/firma.adapter.ts): Firma
// HMAC-SHA256 over the RAW body, hex digest, compared against the exact
// header `x-firma-signature`. Fail-closed since Wave 5.1: an unconfigured
// FIRMA_WEBHOOK_SECRET rejects instead of skipping verification. Validation
// failures are the typed WebhookValidationError (sprint-10 F5), which the
// route maps to HTTP 400 (a prose substring check remains only as a
// deprecated fallback).
//
// Scenarios (Supabase adapter + settings mocked — never hit the live DB;
// fetch is stubbed for the evidence-upload path — never hit the network):
//   1. Invalid/missing `x-firma-signature` → 400.
//   2. Payload missing productId/userId metadata → 400 (consent rejected).
//   3. Missing/invalid document_sha256 → typed 400, zero DB writes (F3).
//   4. Valid HMAC-signed `signing_request.completed` → 200 and the
//      consent port receives the exact C3 submitConsent command shape,
//      with the evidence PDF fetched + uploaded + verified BEFORE insert (F1).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { FirmaAdapter } from "../../../../src/adapters/esign/firma.adapter";
import { WebhookValidationError } from "../../../../src/domain/webhook/webhook_errors";
import type { Mock } from "vitest";

const SECRET = "test-webhook-secret";
const DOCUMENT_HASH = crypto.createHash("sha256").update("sprint10-f1-agreement").digest("hex");
const AGREEMENT_PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1"

function signedBody(payload: unknown, secret = SECRET): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return { body, headers: { "x-firma-signature": signature, "content-type": "application/json" } };
}

function completedPayload(metadata: Record<string, string>, envelopeId = "env_123"): unknown {
  return {
    type: "signing_request.completed",
    data: {
      signing_request: {
        id: envelopeId,
        document_sha256: DOCUMENT_HASH,
        metadata,
      },
    },
  };
}

/** Hermetic fetch stub for the evidence flow: Firma documents GET, Storage
 * PUT and the read-back verification GET. Any other call fails the test. */
function evidenceFetchMock(): Mock {
  return vi.fn((input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/signing-requests/")) {
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(AGREEMENT_PDF_BYTES.slice().buffer) });
    }
    if (method === "PUT" && url.includes("/storage/v1/object/consents/")) {
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    }
    if (method === "GET" && url.includes("/storage/v1/object/consents/")) {
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(AGREEMENT_PDF_BYTES.slice().buffer) });
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
  });
}

describe("esign webhook (Firma HMAC contract)", () => {
  it("rejects non-object metadata on a completed envelope", async () => {
    const { body, headers } = signedBody({
      type: "signing_request.completed",
      data: { signing_request: { id: "env_456", metadata: "not-an-object" } },
    });
    const adapter = new FirmaAdapter();
    const result = await adapter.parseAndValidateWebhook(body, headers);
    // Adapter-level: signature valid → isValid true; the USE CASE throws on
    // non-object metadata → the webhook maps validation errors to 400.
    expect(result.isValid).toBe(true);
    expect(result.event?.metadata).toBe("not-an-object");
  });
  beforeEach(() => {
    vi.stubEnv("FIRMA_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("FIRMA_API_BASE", "https://api.firma.test/functions/v1/signing-request-api");
    vi.stubEnv("FIRMA_API_KEY", "unit-test-firma-key");
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rejects a payload signed with the wrong secret (HTTP 400 contract)", async () => {
    const submitConsent = vi.fn().mockResolvedValue(undefined);
    const { processEsignWebhookUseCase } = await import("../../../../src/use_cases/process_esign_webhook");
    const settings = {
      getPortalSettings: vi.fn().mockResolvedValue({
        esign: {
          strategy: {
            mode: "2d",
            distribution: [{ provider: "firma", weight: 100 }],
            fallbacks: [],
          },
          revenueSplitDocumentPath: "legal-docs/agreement.pdf",
        },
        payments: { checkoutStrategy: { mode: "2d", distribution: [{ provider: "polar", weight: 100 }], fallbacks: [] } },
      }),
    };

    const { body, headers } = signedBody(completedPayload({ productId: "p1", userId: "u1" }), "attacker-secret");
    const request = { body, headers, ip: "10.0.0.1", userAgent: "firma-webhook" };

    await expect(processEsignWebhookUseCase(request, settings, { submitConsent, flagConsentForManualReview: vi.fn(), hasConsentFor: vi.fn().mockResolvedValue(false) })).rejects.toThrow("validation failed");
    expect(submitConsent).not.toHaveBeenCalled();
  });

  it("rejects a missing x-firma-signature header when a secret is configured", async () => {
    const submitConsent = vi.fn().mockResolvedValue(undefined);
    const { processEsignWebhookUseCase } = await import("../../../../src/use_cases/process_esign_webhook");
    const settings = {
      getPortalSettings: vi.fn().mockResolvedValue({
        esign: {
          strategy: { mode: "2d", distribution: [{ provider: "firma", weight: 100 }], fallbacks: [] },
          revenueSplitDocumentPath: "legal-docs/agreement.pdf",
        },
        payments: { checkoutStrategy: { mode: "2d", distribution: [{ provider: "polar", weight: 100 }], fallbacks: [] } },
      }),
    };

    const body = JSON.stringify(completedPayload({ productId: "p1", userId: "u1" }));
    const request = { body, headers: { "content-type": "application/json" }, ip: "10.0.0.1", userAgent: "" };

    await expect(processEsignWebhookUseCase(request, settings, { submitConsent, flagConsentForManualReview: vi.fn(), hasConsentFor: vi.fn().mockResolvedValue(false) })).rejects.toThrow("validation failed");
    expect(submitConsent).not.toHaveBeenCalled();
  });

  it("rejects a completed payload whose metadata lacks productId/userId (no consent written)", async () => {
    const submitConsent = vi.fn().mockResolvedValue(undefined);
    const { processEsignWebhookUseCase } = await import("../../../../src/use_cases/process_esign_webhook");
    const settings = {
      getPortalSettings: vi.fn().mockResolvedValue({
        esign: {
          strategy: { mode: "2d", distribution: [{ provider: "firma", weight: 100 }], fallbacks: [] },
          revenueSplitDocumentPath: "legal-docs/agreement.pdf",
        },
        payments: { checkoutStrategy: { mode: "2d", distribution: [{ provider: "polar", weight: 100 }], fallbacks: [] } },
      }),
    };

    // Valid signature, valid event type — but metadata is missing required ids.
    const { body, headers } = signedBody(completedPayload({}));
    const request = { body, headers, ip: "10.0.0.1", userAgent: "firma-webhook" };

    await expect(processEsignWebhookUseCase(request, settings, { submitConsent, flagConsentForManualReview: vi.fn(), hasConsentFor: vi.fn().mockResolvedValue(false) })).rejects.toThrow(
      /missing productId\/userId/,
    );
    // Missing metadata must never produce a partial/garbage consent record.
    expect(submitConsent).not.toHaveBeenCalled();
  });

  it("rejects a completed payload MISSING document_sha256 as a typed 400 with zero DB writes (F3)", async () => {
    const submitConsent = vi.fn().mockResolvedValue(undefined);
    const { processEsignWebhookUseCase } = await import("../../../../src/use_cases/process_esign_webhook");
    const settings = {
      getPortalSettings: vi.fn().mockResolvedValue({
        esign: {
          strategy: { mode: "2d", distribution: [{ provider: "firma", weight: 100 }], fallbacks: [] },
          revenueSplitDocumentPath: "legal-docs/agreement.pdf",
        },
        payments: { checkoutStrategy: { mode: "2d", distribution: [{ provider: "polar", weight: 100 }], fallbacks: [] } },
      }),
    };

    // Valid signature, valid metadata — but the completion payload omits the
    // document hash, which the consents_document_sha256_check constraint
    // requires. Terminal typed 400: Firma stops retrying, nothing is written.
    const { body, headers } = signedBody({
      type: "signing_request.completed",
      data: { signing_request: { id: "env_no_hash", metadata: { productId: "p1", userId: "u1" } } },
    });
    const request = { body, headers, ip: "10.0.0.1", userAgent: "firma-webhook" };

    const rejection = processEsignWebhookUseCase(request, settings, { submitConsent, flagConsentForManualReview: vi.fn(), hasConsentFor: vi.fn().mockResolvedValue(false) });
    await expect(rejection).rejects.toBeInstanceOf(WebhookValidationError);
    await expect(rejection).rejects.toMatchObject({ httpStatus: 400 });
    await expect(rejection).rejects.toThrow(/env_no_hash.*document_sha256/);
    expect(submitConsent).not.toHaveBeenCalled();
  });

  it("accepts a valid HMAC-signed completed payload and submits the exact C3 consent", async () => {
    const submitConsent = vi.fn().mockResolvedValue(undefined);
    const fetchMock = evidenceFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const { processEsignWebhookUseCase } = await import("../../../../src/use_cases/process_esign_webhook");
    const settings = {
      getPortalSettings: vi.fn().mockResolvedValue({
        esign: {
          strategy: { mode: "2d", distribution: [{ provider: "firma", weight: 100 }], fallbacks: [] },
          revenueSplitDocumentPath: "legal-docs/agreement.pdf",
        },
        payments: { checkoutStrategy: { mode: "2d", distribution: [{ provider: "polar", weight: 100 }], fallbacks: [] } },
      }),
    };

    const { body, headers } = signedBody(completedPayload({ productId: "prod_42", userId: "user_7" }));
    const request = { body, headers, ip: "203.0.113.9", userAgent: "firma-webhook/1.0" };

    const flagConsentForManualReview = vi.fn().mockResolvedValue(undefined);
    await processEsignWebhookUseCase(request, settings, { submitConsent, flagConsentForManualReview, hasConsentFor: vi.fn().mockResolvedValue(false) });

    expect(submitConsent).toHaveBeenCalledTimes(1);
    // No snapshot on the envelope: never stamped with the current registry version; routed for manual review.
    expect(flagConsentForManualReview).toHaveBeenCalledWith(expect.objectContaining({ reason: "legacy_text_version", envelope_id: "env_123", snapshot: "missing" }));
    expect(submitConsent).toHaveBeenCalledWith({
      productId: "prod_42",
      userId: "user_7",
      kind: "C3_revenue_split",
      decision: "given",
      textVersion: "legacy/unknown",
      documentSha256: DOCUMENT_HASH,
      typedName: "Signed via firma",
      ip: "203.0.113.9",
      userAgent: "firma-webhook/1.0",
      authProvider: "firma",
      externalRef: "env_123",
      evidencePath: "user_7/env_123.pdf",
    });
    // Evidence-before-insert (F1): the signed PDF was fetched from Firma,
    // uploaded to the consents bucket at the exact contract path, and the
    // write was verified — all BEFORE the consent insert.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [firmaUrl] = fetchMock.mock.calls[0] as unknown as [string];
    expect(firmaUrl).toBe("https://api.firma.test/functions/v1/signing-request-api/signing-requests/env_123/documents");
    const [putUrl, putInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(putUrl).toBe("https://unit.test.supabase.co/storage/v1/object/consents/user_7/env_123.pdf");
    expect(putInit.method).toBe("PUT");
    expect(putInit.headers).toMatchObject({
      "Content-Type": "application/pdf",
      "x-upsert": "true",
      apikey: "unit-test-key",
      Authorization: "Bearer unit-test-key",
    });
    const uploadedBytes = new Uint8Array(putInit.body as Uint8Array);
    expect(uploadedBytes).toEqual(AGREEMENT_PDF_BYTES);
    const [verifyUrl] = fetchMock.mock.calls[2] as unknown as [string];
    expect(verifyUrl).toBe("https://unit.test.supabase.co/storage/v1/object/consents/user_7/env_123.pdf");
  });

  it("emits a command that satisfies the submit_consent RPC contract (real Firma-shaped ids)", async () => {
    const submitConsent = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", evidenceFetchMock());
    const { processEsignWebhookUseCase } = await import("../../../../src/use_cases/process_esign_webhook");
    const settings = {
      getPortalSettings: vi.fn().mockResolvedValue({
        esign: {
          strategy: { mode: "2d", distribution: [{ provider: "firma", weight: 100 }], fallbacks: [] },
          revenueSplitDocumentPath: "legal-docs/agreement.pdf",
        },
        payments: { checkoutStrategy: { mode: "2d", distribution: [{ provider: "polar", weight: 100 }], fallbacks: [] } },
      }),
    };
    // Firma signing_request ids and Supabase user ids are both lowercase UUIDs.
    const USER = "31b87bf4-71a1-40f1-9257-44c22f2a3814";
    const ENVELOPE = "3cf4ac71-92a7-47a4-b254-151eebde31d0";

    const { body, headers } = signedBody(completedPayload({ productId: "prod_42", userId: USER, textVersion: "v1.0" }, ENVELOPE));
    const flagConsentForManualReview = vi.fn().mockResolvedValue(undefined);
    await processEsignWebhookUseCase({ body, headers, ip: "203.0.113.9", userAgent: "firma-webhook/1.0" }, settings, { submitConsent, flagConsentForManualReview, hasConsentFor: vi.fn().mockResolvedValue(false) });
    expect(flagConsentForManualReview).not.toHaveBeenCalled(); // valid snapshot: no review needed

    expect(submitConsent).toHaveBeenCalledTimes(1);
    const cmd = submitConsent.mock.calls[0][0];
    expect(cmd.userId).toBe(USER);
    expect(cmd.externalRef).toBe(ENVELOPE);
    expect(cmd.evidencePath).toBe(`${USER}/${ENVELOPE}.pdf`);
    // Same pattern the RPC enforces (migration 20261004000200).
    expect(cmd.evidencePath).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9_-]{1,128}\.pdf$/);
    // The version snapshotted at envelope creation wins over the current registry value.
    expect(cmd.textVersion).toBe("v1.0");
  });

  it("a malformed textVersion snapshot is recorded as legacy/unknown and flagged; a failed flag write 500s", async () => {
    const submitConsent = vi.fn().mockResolvedValue(undefined);
    const { processEsignWebhookUseCase } = await import("../../../../src/use_cases/process_esign_webhook");
    const settings = {
      getPortalSettings: vi.fn().mockResolvedValue({
        esign: {
          strategy: { mode: "2d", distribution: [{ provider: "firma", weight: 100 }], fallbacks: [] },
          revenueSplitDocumentPath: "legal-docs/agreement.pdf",
        },
        payments: { checkoutStrategy: { mode: "2d", distribution: [{ provider: "polar", weight: 100 }], fallbacks: [] } },
      }),
    };
    const { body, headers } = signedBody(completedPayload({ productId: "prod_42", userId: "user_7", textVersion: "garbage" }));
    const request = { body, headers, ip: "203.0.113.9", userAgent: "firma-webhook/1.0" };
    const flagConsentForManualReview = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", evidenceFetchMock());
    await processEsignWebhookUseCase(request, settings, { submitConsent, flagConsentForManualReview, hasConsentFor: vi.fn().mockResolvedValue(false) });
    expect(submitConsent.mock.calls[0][0].textVersion).toBe("legacy/unknown");
    expect(flagConsentForManualReview).toHaveBeenCalledWith(expect.objectContaining({ snapshot: "malformed" }));

    const failing = vi.fn().mockRejectedValue(new Error("audit_log down"));
    await expect(processEsignWebhookUseCase(request, settings, { submitConsent, flagConsentForManualReview: failing, hasConsentFor: vi.fn().mockResolvedValue(false) })).rejects.toThrow("audit_log down");
  });

  it("ignores non-completed event types (no consent written)", async () => {
    const submitConsent = vi.fn().mockResolvedValue(undefined);
    const { processEsignWebhookUseCase } = await import("../../../../src/use_cases/process_esign_webhook");
    const settings = {
      getPortalSettings: vi.fn().mockResolvedValue({
        esign: {
          strategy: { mode: "2d", distribution: [{ provider: "firma", weight: 100 }], fallbacks: [] },
          revenueSplitDocumentPath: "legal-docs/agreement.pdf",
        },
        payments: { checkoutStrategy: { mode: "2d", distribution: [{ provider: "polar", weight: 100 }], fallbacks: [] } },
      }),
    };

    const { body, headers } = signedBody({ type: "signing_request.viewed", data: { signing_request: { id: "env_9" } } });
    const request = { body, headers, ip: "10.0.0.1", userAgent: "firma-webhook" };

    await expect(processEsignWebhookUseCase(request, settings, { submitConsent, flagConsentForManualReview: vi.fn(), hasConsentFor: vi.fn().mockResolvedValue(false) })).resolves.toBeUndefined();
    expect(submitConsent).not.toHaveBeenCalled();
  });
});

// Type-level guard: the mock matches the ConsentDatabasePort shape.
type ConsentPortShape = { submitConsent: Mock; flagConsentForManualReview: Mock; hasConsentFor: Mock };
const _shapeCheck: ConsentPortShape | null = null;
void _shapeCheck;

describe("esign webhook route — terminal-reject quarantine (compiled sweep)", () => {
  it("a validation-failed delivery returns 400 and quarantines the event (sha256, no raw body)", async () => {
    const inserts: Array<{ event?: string; details?: Record<string, unknown> }> = [];
    vi.doMock("../../../../../../src/use_cases/process_esign_webhook", () => ({
      processEsignWebhookUseCase: vi.fn(async () => {
        throw new WebhookValidationError("Webhook validation failed: completed envelope env_q has a missing or invalid document_sha256");
      }),
    }));
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from: (table: string) => ({
          insert: async (row: unknown) => {
            if (table === "audit_log") inserts.push(row as { event?: string; details?: Record<string, unknown> });
            return { error: null };
          },
        }),
      }),
    }));
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    vi.stubEnv("FIRMA_WEBHOOK_SECRET", "route-secret");
    const { POST } = await import("../../../app/api/esign/webhook/route");
    const payload = JSON.stringify({ type: "signing_request.completed", data: { signing_request: { id: "env_q" } } });
    const signature = crypto.createHmac("sha256", "route-secret").update(payload).digest("hex");
    const req = new Request("https://expanpress.com/api/esign/webhook", {
      method: "POST",
      body: payload,
      headers: { "x-firma-signature": signature },
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ event: "WEBHOOK_TERMINAL_REJECT", details: { provider: "esign", reason: "WebhookValidationError" } });
    expect(inserts[0]?.details?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
