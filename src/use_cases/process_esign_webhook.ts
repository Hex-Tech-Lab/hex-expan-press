import { SettingsRegistryPort } from "../domain/settings/settings.port.ts";
import { createEsignAdapter } from "../adapters/esign/esign.factory.ts";
import { ConsentDatabasePort } from "../domain/governance/consent.port.ts";
import { WebhookValidationError } from "../domain/webhook/webhook_errors.ts";
import { consentTextVersion } from "../../payments/src/settings_registry.ts";

export interface ProcessEsignWebhookRequest {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
  userAgent: string;
}

// Enforced by consents_document_sha256_check (64-hex NOT NULL) in the DB.
const DOCUMENT_SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export async function processEsignWebhookUseCase(
  req: ProcessEsignWebhookRequest,
  settingsRegistry: SettingsRegistryPort,
  database: ConsentDatabasePort
): Promise<void> {
  const settings = await settingsRegistry.getPortalSettings();
  const esignAdapter = createEsignAdapter(settings.esign);

  // 1. Validate and Parse Webhook (Provider-agnostic)
  const validation = esignAdapter.parseAndValidateWebhook(req.body, req.headers);
  if (!validation.isValid || !validation.event) {
    throw new WebhookValidationError(`Webhook validation failed: ${validation.error}`);
  }

  const { event } = validation;

  // 2. Map domain event to governance actions
  if (event.eventType === "envelope.completed") {
    // Metadata integrity gate (Wave 5.1, hardened): metadata must BE an
    // object with non-empty string productId/userId BEFORE destructuring —
    // a completed envelope without that linkage can never be attributed to
    // a consent record, so reject (typed 400, terminal — Firma stops
    // retrying) instead of writing a partial/garbage consent row.
    const metadata = event.metadata as unknown;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new WebhookValidationError(`Webhook validation failed: completed envelope ${event.envelopeId} has no metadata object`);
    }
    const { productId, userId, textVersion } = metadata as Record<string, unknown>;
    if (typeof productId !== "string" || productId.trim() === "" || typeof userId !== "string" || userId.trim() === "") {
      throw new WebhookValidationError(`Webhook validation failed: completed envelope ${event.envelopeId} is missing productId/userId metadata`);
    }
    const envelopeId = event.envelopeId;

    // Hash gate (sprint-10 audit F3): an empty or non-64-hex document_sha256
    // violates consents_document_sha256_check. Previously the DB rejection was
    // classified 500, so Firma retried a permanently-invalid payload forever.
    // Typed 400 is terminal; the envelope lands in ops. The hash is taken
    // as-is from the adapter — no value is ever fabricated here.
    if (!DOCUMENT_SHA256_PATTERN.test(event.documentHash)) {
      throw new WebhookValidationError(
        `Webhook validation failed: completed envelope ${envelopeId} has a missing or invalid document_sha256 (expected 64 hex characters, got ${event.documentHash ? `length ${event.documentHash.length}` : "empty"})`
      );
    }

    // The PDF path is abstracted here, but typically bounded to user and envelope
    const pdfPath = `${userId}/${envelopeId}.pdf`;

    // The version snapshotted at envelope creation. Envelopes created before the snapshot
    // existed fall back to the registry; a present-but-malformed snapshot also falls back
    // (rejecting would make Firma retry forever and lose the C3) but is logged loudly.
    let snapshotTextVersion = consentTextVersion();
    if (typeof textVersion === "string" && /^v\d+(\.\d+)*$/.test(textVersion)) {
      snapshotTextVersion = textVersion;
    } else if (textVersion !== undefined) {
      console.error(`[esign-webhook] envelope ${envelopeId} has a malformed textVersion snapshot; recording registry version ${snapshotTextVersion}`);
    }

    // Evidence-before-insert (sprint-10 audit F1): the signed PDF must exist in
    // Storage BEFORE any consent row references it. Fetch the completed
    // document, upload + read-back verify it — any failure throws here, the
    // route answers 500, Firma retries, and NO consent row is written. The
    // previous phantom path (`pdfPath` persisted without an upload) is gone.
    const pdfBytes = await esignAdapter.fetchCompletedDocument(envelopeId);
    await esignAdapter.uploadConsentEvidence(pdfPath, pdfBytes);

    // 3. Persist the legal consent (C3) using the Database Port
    try {
      await database.submitConsent({
        productId: productId,
        userId: userId, // Used to construct path or extra validation if needed by adapter
        kind: "C3_revenue_split",
        decision: "given",
        textVersion: snapshotTextVersion,
        documentSha256: event.documentHash,
        typedName: `Signed via ${validation.providerName || "unknown"}`,
        ip: req.ip,
        userAgent: req.userAgent,
        authProvider: validation.providerName || "unknown",
        externalRef: envelopeId,
        evidencePath: pdfPath
      });
    } catch (err) {
      // Replay of an already-recorded envelope: the unique (kind, external_ref)
      // index rejects the second row (audit F5). Acknowledge ONLY when the
      // violated constraint is consents_kind_external_ref_uidx. Storage upsert
      // semantics make the preceding re-upload idempotent, so the replay path
      // stays acknowledged-200.
      const e = err as { code?: unknown; constraint?: unknown; message?: unknown };
      if (
        e?.code === "23505" &&
        (e.constraint === "consents_kind_external_ref_uidx" ||
          (typeof e.message === "string" && e.message.includes("consents_kind_external_ref_uidx")))
      ) {
        console.info(`[esign.webhook] acknowledged replayed envelope envelope_id=${envelopeId} kind=C3_revenue_split`);
        return;
      }
      throw err;
    }
  }
}
