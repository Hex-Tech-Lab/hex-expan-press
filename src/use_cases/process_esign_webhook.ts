import { SettingsRegistryPort } from "../domain/settings/settings.port.ts";
import { createEsignAdapter } from "../adapters/esign/esign.factory.ts";
import { ConsentDatabasePort } from "../domain/governance/consent.port.ts";
import { WebhookValidationError } from "../domain/webhook/webhook_errors.ts";

/** text_version recorded when the envelope carries no valid snapshot of the wording the signer saw. */
export const LEGACY_TEXT_VERSION = "legacy/unknown";

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
    // httpStatus hint (401 unauthenticated / 400 post-auth) flows to the route,
    // which must NOT quarantine unauthenticated rejects.
    throw new WebhookValidationError(`Webhook validation failed: ${validation.error}`, validation.httpStatus ?? 400);
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
    // swallowed by the retry loop (500 forever); the typed 400 is terminal and
    // the envelope lands in ops. The hash is taken as-is from the adapter — no
    // value is ever fabricated here. String-type guard first: a one-element
    // JSON array stringifies through the regex, then explodes on .toLowerCase()
    // with an unhandled 500 (external review PR #78).
    if (typeof event.documentHash !== "string" || !DOCUMENT_SHA256_PATTERN.test(event.documentHash)) {
      throw new WebhookValidationError(
        `Webhook validation failed: completed envelope ${envelopeId} has a missing or invalid document_sha256 (expected 64 hex characters, got ${typeof event.documentHash === "string" && event.documentHash ? `length ${event.documentHash.length}` : "empty"})`
      );
    }
    // Lowercase-normalize BEFORE persistence: the DB CHECK (and every RPC validation)
    // is case-sensitive lowercase hex, so an uppercase digest would pass this gate and
    // then die at the DB — a 500 retry loop — instead of a terminal 400.
    const documentHash = event.documentHash.toLowerCase();

    // The version snapshotted at envelope creation is the wording the signer actually saw. A missing or
    // malformed snapshot is NEVER replaced by the current registry version (that would label the signature
    // with a contract the signer never saw): record LEGACY_TEXT_VERSION and route it for manual review.
    // Rejecting instead would make Firma retry forever and lose the C3.
    let snapshotTextVersion = LEGACY_TEXT_VERSION;
    let provenanceReason: "missing" | "malformed" | null = "missing";
    if (typeof textVersion === "string" && /^v\d+(\.\d+)*$/.test(textVersion)) {
      snapshotTextVersion = textVersion;
      provenanceReason = null;
    } else if (textVersion !== undefined) {
      provenanceReason = "malformed";
    }

    // At-least-once: also re-run on a replay, so a flag write that failed after the consent landed is not lost.
    const flagLegacyProvenance = async (): Promise<void> => {
      if (provenanceReason === null) return;
      console.error(`[esign-webhook] envelope ${envelopeId} has a ${provenanceReason} textVersion snapshot; recorded ${LEGACY_TEXT_VERSION}, flagged for manual review`);
      await database.flagConsentForManualReview({
        reason: "legacy_text_version",
        kind: "C3_revenue_split",
        envelope_id: envelopeId,
        product_id: productId,
        user_id: userId,
        snapshot: provenanceReason,
      });
    };

    // Replay pre-check (P2, external review PR #78): look for an existing
    // consent (kind, external_ref) AFTER metadata validation but BEFORE the
    // evidence round-trip. A replayed envelope must not depend on Firma
    // document retention or a live Firma API (replays previously 500ed
    // forever once fetchCompletedDocument stopped succeeding) and must not
    // pay the wasted fetch+upload round-trips. The 23505 catch below remains
    // as the backstop for the concurrent-first-delivery race.
    let alreadyRecorded = false;
    try {
      alreadyRecorded = await database.hasConsentFor("C3_revenue_split", envelopeId);
    } catch (lookupErr) {
      // Lookup failure (transient DB issue): fall through to the evidence +
      // insert flow; the insert is still unique-constrained, so correctness
      // is preserved either way. Logged: a PERSISTENT consent-DB fault must
      // not be silent — every replay would pay the full Firma fetch/upload.
      console.warn(`[esign.webhook] replay pre-check failed envelope_id=${envelopeId}; falling through`, lookupErr instanceof Error ? lookupErr.name : "unknown");
    }
    if (alreadyRecorded) {
      console.info(`[esign.webhook] acknowledged replayed envelope envelope_id=${envelopeId} kind=C3_revenue_split`);
      await flagLegacyProvenance();
      return;
    }

    // The PDF path is abstracted here, but typically bounded to user and envelope
    const pdfPath = `${userId}/${envelopeId}.pdf`;

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
        documentSha256: documentHash,
        typedName: `Signed via ${validation.providerName || "unknown"}`,
        ip: req.ip,
        userAgent: req.userAgent,
        authProvider: validation.providerName || "unknown",
        externalRef: envelopeId,
        evidencePath: pdfPath
      });
      await flagLegacyProvenance();
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
        await flagLegacyProvenance();
        return;
      }
      throw err;
    }
  }
}
