// Sprint-10 audit remediation coverage for processEsignWebhookUseCase:
//   F1 (P0): the signed PDF must be fetched, uploaded to Storage and
//            read-back verified BEFORE any consent row is written — the
//            previously fabricated evidencePath pointed at objects that
//            never existed. Any evidence failure aborts with no DB write.
//   F3 (P1): a completed envelope without a valid 64-hex document_sha256
//            is a terminal typed validation error (400), never a retry loop.
//   F5 (P1): validation failures throw the typed WebhookValidationError so
//            route classification no longer depends on error prose.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebhookValidationError } from "../../domain/webhook/webhook_errors.ts";
import type { WebhookEvent, WebhookValidationResult } from "../../domain/esign/esign.port.ts";

const AGREEMENT_PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1"
const VALID_HASH = "a".repeat(64);

const firmaMock = vi.hoisted(() => ({
  parseResult: null as unknown,
  fetchCompletedDocument: vi.fn(),
  uploadConsentEvidence: vi.fn(),
}));

vi.mock("../../adapters/esign/esign.factory.ts", () => ({
  createEsignAdapter: () => ({
    parseAndValidateWebhook: () => firmaMock.parseResult,
    fetchCompletedDocument: (envelopeId: string) => firmaMock.fetchCompletedDocument(envelopeId),
    uploadConsentEvidence: (objectPath: string, bytes: Uint8Array) => firmaMock.uploadConsentEvidence(objectPath, bytes),
  }),
}));

function completedEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    eventType: "envelope.completed",
    envelopeId: "env_f125",
    metadata: { productId: "prod_1", userId: "user_9" },
    documentHash: VALID_HASH,
    ...overrides,
  };
}

function validParseResult(event: WebhookEvent): WebhookValidationResult {
  return { isValid: true, providerName: "firma", event };
}

function makeDatabase() {
  return { submitConsent: vi.fn<(command: Record<string, unknown>) => Promise<void>>(() => Promise.resolve()) };
}

const settings = { getPortalSettings: () => Promise.resolve({ esign: {} }) };
const request = { body: "{}", headers: {}, ip: "203.0.113.7", userAgent: "firma-webhook/1.0" };

describe("processEsignWebhookUseCase — evidence-before-insert (F1)", () => {
  beforeEach(() => {
    firmaMock.parseResult = null;
    firmaMock.fetchCompletedDocument.mockReset();
    firmaMock.uploadConsentEvidence.mockReset();
  });

  it("fetches the signed PDF, uploads it at the exact contract path, THEN inserts the consent", async () => {
    firmaMock.parseResult = validParseResult(completedEvent());
    let uploadedBytes: Uint8Array | null = null;
    const callOrder: string[] = [];
    firmaMock.fetchCompletedDocument.mockImplementation((envelopeId: string) => {
      callOrder.push(`fetch:${envelopeId}`);
      return Promise.resolve(AGREEMENT_PDF_BYTES);
    });
    firmaMock.uploadConsentEvidence.mockImplementation((objectPath: string, bytes: Uint8Array) => {
      callOrder.push(`upload:${objectPath}`);
      uploadedBytes = bytes;
      return Promise.resolve();
    });
    const database = {
      submitConsent: vi.fn((command: { evidencePath?: string }) => {
        callOrder.push(`insert:${command.evidencePath}`);
        return Promise.resolve();
      }),
    };

    const { processEsignWebhookUseCase } = await import("../process_esign_webhook.ts");
    await processEsignWebhookUseCase(request, settings as never, database as never);

    expect(callOrder).toEqual(["fetch:env_f125", "upload:user_9/env_f125.pdf", "insert:user_9/env_f125.pdf"]);
    expect(uploadedBytes).toBe(AGREEMENT_PDF_BYTES);
    expect(database.submitConsent).toHaveBeenCalledTimes(1);
    expect(database.submitConsent.mock.calls[0][0]).toMatchObject({
      evidencePath: "user_9/env_f125.pdf",
      documentSha256: VALID_HASH,
      externalRef: "env_f125",
    });
  });

  it("does NOT insert a consent when the storage upload fails (500 → Firma retries, no phantom evidence)", async () => {
    firmaMock.parseResult = validParseResult(completedEvent());
    firmaMock.fetchCompletedDocument.mockReturnValue(Promise.resolve(AGREEMENT_PDF_BYTES));
    firmaMock.uploadConsentEvidence.mockReturnValue(Promise.reject(new Error("Consent evidence upload failed (502)")));
    const database = makeDatabase();

    const { processEsignWebhookUseCase } = await import("../process_esign_webhook.ts");
    await expect(processEsignWebhookUseCase(request, settings as never, database as never)).rejects.toThrow(
      /Consent evidence upload failed/,
    );

    expect(firmaMock.fetchCompletedDocument).toHaveBeenCalledTimes(1);
    expect(firmaMock.uploadConsentEvidence).toHaveBeenCalledTimes(1);
    expect(database.submitConsent).not.toHaveBeenCalled();
  });

  it("does NOT upload or insert when the completed-document fetch fails", async () => {
    firmaMock.parseResult = validParseResult(completedEvent());
    firmaMock.fetchCompletedDocument.mockReturnValue(
      Promise.reject(new Error("Firma completed-document fetch failed (503) for envelope env_f125")),
    );
    const database = makeDatabase();

    const { processEsignWebhookUseCase } = await import("../process_esign_webhook.ts");
    await expect(processEsignWebhookUseCase(request, settings as never, database as never)).rejects.toThrow(
      /completed-document fetch failed/,
    );

    expect(firmaMock.uploadConsentEvidence).not.toHaveBeenCalled();
    expect(database.submitConsent).not.toHaveBeenCalled();
  });

  it("keeps the replay path acknowledged-200 with an idempotent re-upload before the insert", async () => {
    firmaMock.parseResult = validParseResult(completedEvent());
    firmaMock.fetchCompletedDocument.mockReturnValue(Promise.resolve(AGREEMENT_PDF_BYTES));
    firmaMock.uploadConsentEvidence.mockReturnValue(Promise.resolve());
    const replayError = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint: "consents_kind_external_ref_uidx",
    });
    const database = { submitConsent: vi.fn(() => Promise.reject(replayError)) };

    const { processEsignWebhookUseCase } = await import("../process_esign_webhook.ts");
    await expect(processEsignWebhookUseCase(request, settings as never, database as never)).resolves.toBeUndefined();
  });
});

describe("processEsignWebhookUseCase — document hash gate (F3)", () => {
  beforeEach(() => {
    firmaMock.parseResult = null;
    firmaMock.fetchCompletedDocument.mockReset();
    firmaMock.uploadConsentEvidence.mockReset();
  });

  it("rejects a completed envelope with a MISSING document_sha256 as a typed 400 with zero side effects", async () => {
    firmaMock.parseResult = validParseResult(completedEvent({ documentHash: "" }));
    const database = makeDatabase();

    const { processEsignWebhookUseCase } = await import("../process_esign_webhook.ts");
    const rejection = processEsignWebhookUseCase(request, settings as never, database as never);
    await expect(rejection).rejects.toBeInstanceOf(WebhookValidationError);
    await expect(rejection).rejects.toMatchObject({ httpStatus: 400 });
    await expect(rejection).rejects.toThrow(/env_f125.*document_sha256/);
    expect(firmaMock.fetchCompletedDocument).not.toHaveBeenCalled();
    expect(firmaMock.uploadConsentEvidence).not.toHaveBeenCalled();
    expect(database.submitConsent).not.toHaveBeenCalled();
  });

  it("rejects wrong-length and non-hex document hashes as terminal 400s", async () => {
    const { processEsignWebhookUseCase } = await import("../process_esign_webhook.ts");
    for (const invalidHash of ["a".repeat(63), "z".repeat(64), "abc123hash"]) {
      firmaMock.parseResult = validParseResult(completedEvent({ documentHash: invalidHash }));
      const database = makeDatabase();
      await expect(processEsignWebhookUseCase(request, settings as never, database as never)).rejects.toBeInstanceOf(
        WebhookValidationError,
      );
      expect(firmaMock.fetchCompletedDocument).not.toHaveBeenCalled();
      expect(firmaMock.uploadConsentEvidence).not.toHaveBeenCalled();
      expect(database.submitConsent).not.toHaveBeenCalled();
    }
  });

  it("passes a valid 64-hex hash through to the consent command unchanged", async () => {
    firmaMock.parseResult = validParseResult(completedEvent({ documentHash: VALID_HASH }));
    firmaMock.fetchCompletedDocument.mockReturnValue(Promise.resolve(AGREEMENT_PDF_BYTES));
    firmaMock.uploadConsentEvidence.mockReturnValue(Promise.resolve());
    const database = makeDatabase();

    const { processEsignWebhookUseCase } = await import("../process_esign_webhook.ts");
    await processEsignWebhookUseCase(request, settings as never, database as never);

    expect(database.submitConsent.mock.calls[0][0]).toMatchObject({ documentSha256: VALID_HASH });
  });
});

describe("processEsignWebhookUseCase — typed validation errors (F5)", () => {
  beforeEach(() => {
    firmaMock.parseResult = null;
    firmaMock.fetchCompletedDocument.mockReset();
    firmaMock.uploadConsentEvidence.mockReset();
  });

  it("throws WebhookValidationError (400) when the provider rejects the webhook signature", async () => {
    firmaMock.parseResult = { isValid: false, error: "Invalid signature" } as WebhookValidationResult;
    const database = makeDatabase();

    const { processEsignWebhookUseCase } = await import("../process_esign_webhook.ts");
    await expect(processEsignWebhookUseCase(request, settings as never, database as never)).rejects.toMatchObject({
      name: "WebhookValidationError",
      httpStatus: 400,
    });
    expect(database.submitConsent).not.toHaveBeenCalled();
  });
});

describe("WebhookValidationError classification contract (F5)", () => {
  it("a REWORDED message still classifies as validation (instanceof wins over prose)", () => {
    const reworded = new WebhookValidationError("signature stale and unrecognizable for envelope env_f125");
    expect(reworded).toBeInstanceOf(WebhookValidationError);
    expect(reworded.httpStatus).toBe(400);
    expect(reworded.message).not.toContain("validation failed");
  });

  it("a plain infra Error mentioning validation is NOT typed (route must 500, not 400)", () => {
    const infra = new Error("consent evidence verification pipeline unavailable before validation");
    expect(infra).not.toBeInstanceOf(WebhookValidationError);
  });
});
