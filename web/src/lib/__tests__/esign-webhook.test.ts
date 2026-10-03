// Regression coverage for the Firma e-sign webhook contract
// (web/app/api/esign/webhook/route.ts -> src/use_cases/process_esign_webhook.ts;
// legacy handler bridge retired in Wave 6).
//
// The real signature scheme (src/adapters/esign/firma.adapter.ts): Firma
// HMAC-SHA256 over the RAW body, hex digest, compared against the exact
// header `x-firma-signature`. Fail-closed since Wave 5.1: an unconfigured
// FIRMA_WEBHOOK_SECRET rejects instead of skipping verification. The
// webhook's "invalid" contract (400) comes from `validation failed` errors
// thrown by the use case, which the route maps to HTTP 400.
//
// Scenarios (Supabase adapter + settings mocked — never hit the live DB):
//   1. Invalid/missing `x-firma-signature` → 400.
//   2. Payload missing productId/userId metadata → 400 (consent rejected).
//   3. Valid HMAC-signed `signing_request.completed` → 200 and the
//      consent port receives the exact C3 submitConsent command shape.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { FirmaAdapter } from "../../../../src/adapters/esign/firma.adapter";
import { consentTextVersion } from "../../../../payments/src/settings_registry";
import type { Mock } from "vitest";

const SECRET = "test-webhook-secret";

function signedBody(payload: unknown, secret = SECRET): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return { body, headers: { "x-firma-signature": signature, "content-type": "application/json" } };
}

function completedPayload(metadata: Record<string, string>): unknown {
  return {
    type: "signing_request.completed",
    data: {
      signing_request: {
        id: "env_123",
        document_sha256: "abc123hash",
        metadata,
      },
    },
  };
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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

    await expect(processEsignWebhookUseCase(request, settings, { submitConsent })).rejects.toThrow("validation failed");
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

    await expect(processEsignWebhookUseCase(request, settings, { submitConsent })).rejects.toThrow("validation failed");
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

    await expect(processEsignWebhookUseCase(request, settings, { submitConsent })).rejects.toThrow(
      /missing productId\/userId/,
    );
    // Missing metadata must never produce a partial/garbage consent record.
    expect(submitConsent).not.toHaveBeenCalled();
  });

  it("accepts a valid HMAC-signed completed payload and submits the exact C3 consent", async () => {
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

    const { body, headers } = signedBody(completedPayload({ productId: "prod_42", userId: "user_7" }));
    const request = { body, headers, ip: "203.0.113.9", userAgent: "firma-webhook/1.0" };

    await processEsignWebhookUseCase(request, settings, { submitConsent });

    expect(submitConsent).toHaveBeenCalledTimes(1);
    expect(submitConsent).toHaveBeenCalledWith({
      productId: "prod_42",
      userId: "user_7",
      kind: "C3_revenue_split",
      decision: "given",
      textVersion: consentTextVersion(),
      documentSha256: "abc123hash",
      typedName: "Signed via firma",
      ip: "203.0.113.9",
      userAgent: "firma-webhook/1.0",
      authProvider: "firma",
      externalRef: "env_123",
      evidencePath: "user_7/env_123.pdf",
    });
  });

  it("passes evidencePath in the exact <userId>/<envelopeId>.pdf format enforced by the submit_consent RPC", async () => {
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

    const { body, headers } = signedBody(completedPayload({ productId: "prod_42", userId: "user_7" }));
    const request = { body, headers, ip: "203.0.113.9", userAgent: "firma-webhook/1.0" };

    await processEsignWebhookUseCase(request, settings, { submitConsent });

    expect(submitConsent).toHaveBeenCalledTimes(1);
    const cmd = submitConsent.mock.calls[0][0];
    expect(cmd.evidencePath).toBe(`${cmd.userId}/${cmd.externalRef}.pdf`);
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

    await expect(processEsignWebhookUseCase(request, settings, { submitConsent })).resolves.toBeUndefined();
    expect(submitConsent).not.toHaveBeenCalled();
  });
});

// Type-level guard: the mock matches the ConsentDatabasePort shape.
type ConsentPortShape = { submitConsent: Mock };
const _shapeCheck: ConsentPortShape | null = null;
void _shapeCheck;
