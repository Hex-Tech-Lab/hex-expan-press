import { describe, it, expect, vi } from "vitest";
import { CompositeEsignAdapter, type EsignAdapter } from "../esign.factory.ts";
import type { CreateEnvelopeCommand } from "../../../domain/esign/esign.port.ts";
import type { ProviderStrategy } from "../../../domain/settings/settings.port.ts";

function createMockAdapter(name: string, overrides: Partial<EsignAdapter> = {}): EsignAdapter {
  return {
    createEnvelope: vi.fn().mockResolvedValue({
      envelopeId: `env_${name}`,
      signUrl: `https://app.${name}.test/signing/123`,
    }),
    parseAndValidateWebhook: vi.fn().mockReturnValue({ isValid: true, event: { eventId: "evt_1" } }),
    fetchCompletedDocument: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    uploadConsentEvidence: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("CompositeEsignAdapter", () => {
  const dummyCommand: CreateEnvelopeCommand = {
    agreementPath: "agreements/prod_test.pdf",
    signers: [{ name: "Alex Creator", email: "alex@example.com" }],
    metadata: { productId: "prod_test", creatorName: "Alex Creator" },
    redirectUrl: "https://expanpress.com/creator/dashboard",
    webhookUrl: "https://expanpress.com/api/esign/webhook",
  };

  it("successfully creates envelope via primary provider", async () => {
    const primary = createMockAdapter("firma");
    const fallback = createMockAdapter("docusign");
    const adapterMap = new Map<string, EsignAdapter>([
      ["firma", primary],
      ["docusign", fallback],
    ]);
    const strategy: ProviderStrategy = {
      mode: "2d",
      distribution: [{ provider: "firma", weight: 100 }],
      fallbacks: ["docusign"],
    };

    const composite = new CompositeEsignAdapter(strategy, adapterMap);
    const result = await composite.createEnvelope(dummyCommand);

    expect(result.envelopeId).toBe("env_firma");
    expect(primary.createEnvelope).toHaveBeenCalledWith(dummyCommand);
    expect(fallback.createEnvelope).not.toHaveBeenCalled();
  });

  it("cascades to fallback provider when primary fails", async () => {
    const primaryErr = new Error("Firma primary down (503)");
    const primary = createMockAdapter("firma", {
      createEnvelope: vi.fn().mockRejectedValue(primaryErr),
    });
    const fallback = createMockAdapter("docusign");
    const adapterMap = new Map<string, EsignAdapter>([
      ["firma", primary],
      ["docusign", fallback],
    ]);
    const strategy: ProviderStrategy = {
      mode: "2d",
      distribution: [{ provider: "firma", weight: 100 }],
      fallbacks: ["docusign"],
    };

    const composite = new CompositeEsignAdapter(strategy, adapterMap);
    const result = await composite.createEnvelope(dummyCommand);

    expect(result.envelopeId).toBe("env_docusign");
    expect(primary.createEnvelope).toHaveBeenCalledWith(dummyCommand);
    expect(fallback.createEnvelope).toHaveBeenCalledWith(dummyCommand);
  });

  it("accumulates all errors in AggregateError cause when primary and fallbacks fail (Cubic P2)", async () => {
    const primaryErr = new Error("Firma create-and-send failed (500): internal error");
    const fallbackErr = new Error("DocuSign create-and-send failed (402): insufficient credits");
    (fallbackErr as unknown as { status: number }).status = 402;

    const primary = createMockAdapter("firma", {
      createEnvelope: vi.fn().mockRejectedValue(primaryErr),
    });
    const fallback = createMockAdapter("docusign", {
      createEnvelope: vi.fn().mockRejectedValue(fallbackErr),
    });
    const adapterMap = new Map<string, EsignAdapter>([
      ["firma", primary],
      ["docusign", fallback],
    ]);
    const strategy: ProviderStrategy = {
      mode: "2d",
      distribution: [{ provider: "firma", weight: 100 }],
      fallbacks: ["docusign"],
    };

    const composite = new CompositeEsignAdapter(strategy, adapterMap);

    await expect(composite.createEnvelope(dummyCommand)).rejects.toThrowError(
      /All configured esign providers failed \(Primary: firma: Firma create-and-send failed \(500\): internal error, Fallbacks: docusign \| Fallbacks: docusign: DocuSign create-and-send failed \(402\): insufficient credits\)/
    );

    try {
      await composite.createEnvelope(dummyCommand);
      expect.fail("Should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      const e = err as Error;
      expect(e.cause).toBeInstanceOf(AggregateError);
      const agg = e.cause as AggregateError;
      expect(agg.errors).toHaveLength(2);
      expect(agg.errors[0]).toBe(primaryErr);
      expect(agg.errors[1]).toBe(fallbackErr);
      expect((agg.errors[1] as unknown as { status: number }).status).toBe(402);
    }
  });

  it("requires a validated webhook before evidence operations", () => {
    const adapterMap = new Map<string, EsignAdapter>([["firma", createMockAdapter("firma")]]);
    const strategy: ProviderStrategy = {
      mode: "2d",
      distribution: [{ provider: "firma", weight: 100 }],
      fallbacks: [],
    };
    const composite = new CompositeEsignAdapter(strategy, adapterMap);

    expect(() => composite.fetchCompletedDocument("env_1")).toThrowError(
      "No e-sign provider validated this webhook — evidence operations are unavailable"
    );
    expect(() => composite.uploadConsentEvidence("path/doc.pdf", new Uint8Array())).toThrowError(
      "No e-sign provider validated this webhook — evidence operations are unavailable"
    );
  });
});
