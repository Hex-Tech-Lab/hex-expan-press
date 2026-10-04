import { SettingsRegistryPort } from "../domain/settings/settings.port.ts";
import { createEsignAdapter } from "../adapters/esign/esign.factory.ts";
import { ConsentDatabasePort } from "../domain/governance/consent.port.ts";

/** text_version recorded when the envelope carries no valid snapshot of the wording the signer saw. */
export const LEGACY_TEXT_VERSION = "legacy/unknown";

export interface ProcessEsignWebhookRequest {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
  userAgent: string;
}

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
    throw new Error(`Webhook validation failed: ${validation.error}`);
  }

  const { event } = validation;

  // 2. Map domain event to governance actions
  if (event.eventType === "envelope.completed") {
    // Metadata integrity gate (Wave 5.1, hardened): metadata must BE an
    // object with non-empty string productId/userId BEFORE destructuring —
    // a completed envelope without that linkage can never be attributed to
    // a consent record, so reject (400 via the webhook's validation-failed
    // contract) instead of writing a partial/garbage consent row.
    const metadata = event.metadata as unknown;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error(`Webhook validation failed: completed envelope ${event.envelopeId} has no metadata object`);
    }
    const { productId, userId, textVersion } = metadata as Record<string, unknown>;
    if (typeof productId !== "string" || productId.trim() === "" || typeof userId !== "string" || userId.trim() === "") {
      throw new Error(`Webhook validation failed: completed envelope ${event.envelopeId} is missing productId/userId metadata`);
    }
    const envelopeId = event.envelopeId;

    // The PDF path is abstracted here, but typically bounded to user and envelope
    const pdfPath = `${userId}/${envelopeId}.pdf`;

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
      await flagLegacyProvenance();
    } catch (err) {
      // Replay of an already-recorded envelope: the unique (kind, external_ref)
      // index rejects the second row (audit F5). Acknowledge ONLY when the
      // violated constraint is consents_kind_external_ref_uidx.
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
