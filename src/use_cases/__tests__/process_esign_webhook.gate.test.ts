// PR 136 e-sign path gate: the whole-segment contract holds even when the registry override is permissive, and the
// adapter's "unknown" placeholder id is refused before any fetch or upload.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { WebhookValidationError } from "../../domain/webhook/webhook_errors.ts";
import type { WebhookEvent, WebhookValidationResult } from "../../domain/esign/esign.port.ts";
import { processEsignWebhookUseCase } from "../process_esign_webhook.ts";

const USER_UUID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const HASH = createHash("sha256").update(PDF).digest("hex");

const firma = vi.hoisted(() => ({
  parseResult: null as unknown,
  fetchCompletedDocument: vi.fn(async (_envelopeId: string) => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])),
  uploadConsentEvidence: vi.fn(async (_path: string, _bytes: Uint8Array) => undefined),
}));

// A permissive registry override: it would accept anything, including a slash-containing segment.
vi.mock("../../../payments/src/settings_registry.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../payments/src/settings_registry.ts")>()),
  consentEvidencePathRules: () => ({ userId: /.*/, envelopeId: /.*/ }),
}));

vi.mock("../../adapters/esign/esign.factory.ts", () => ({
  createEsignAdapter: () => ({
    parseAndValidateWebhook: () => firma.parseResult,
    fetchCompletedDocument: (id: string) => firma.fetchCompletedDocument(id),
    uploadConsentEvidence: (path: string, bytes: Uint8Array) => firma.uploadConsentEvidence(path, bytes),
  }),
}));

function completed(envelopeId: string): WebhookEvent {
  return {
    eventType: "envelope.completed",
    envelopeId,
    metadata: { productId: "prod_1", userId: USER_UUID },
    documentHash: HASH,
  } as WebhookEvent;
}

function parsed(event: WebhookEvent): WebhookValidationResult {
  return { isValid: true, providerName: "firma", event };
}

function database() {
  return {
    submitConsent: vi.fn(async () => undefined),
    flagConsentForManualReview: vi.fn(async () => undefined),
    hasConsentFor: vi.fn(async () => false),
  };
}

const settings = { getPortalSettings: async () => ({ esign: {} }) } as never;
const request = { body: "{}", headers: {}, ip: "203.0.113.7", userAgent: "firma-webhook/1.0" };

describe("e-sign completed-envelope path gate", () => {
  beforeEach(() => {
    firma.fetchCompletedDocument.mockClear();
    firma.uploadConsentEvidence.mockClear();
  });

  it.each([
    ["a slash-containing envelope id", "a/../b"],
    ["a dot segment", ".."],
    ["a space", "env id"],
  ])("refuses %s even when the registry override is permissive, before any fetch or upload", async (_label, envelopeId) => {
    firma.parseResult = parsed(completed(envelopeId));
    const db = database();
    await expect(processEsignWebhookUseCase(request, settings, db as never)).rejects.toBeInstanceOf(WebhookValidationError);
    expect(firma.fetchCompletedDocument).not.toHaveBeenCalled();
    expect(firma.uploadConsentEvidence).not.toHaveBeenCalled();
    expect(db.submitConsent).not.toHaveBeenCalled();
  });

  it("refuses the adapter's placeholder id 'unknown' with a terminal 400 before any fetch or upload", async () => {
    firma.parseResult = parsed(completed("unknown"));
    const db = database();
    const err = await processEsignWebhookUseCase(request, settings, db as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookValidationError);
    expect((err as WebhookValidationError).httpStatus).toBe(400);
    expect(firma.fetchCompletedDocument).not.toHaveBeenCalled();
    expect(firma.uploadConsentEvidence).not.toHaveBeenCalled();
  });

  it("a real envelope id still reaches the evidence step", async () => {
    firma.parseResult = parsed(completed("env_real_1"));
    const db = database();
    await processEsignWebhookUseCase(request, settings, db as never);
    expect(firma.fetchCompletedDocument).toHaveBeenCalledWith("env_real_1");
    expect(db.submitConsent).toHaveBeenCalledTimes(1);
  });
});
