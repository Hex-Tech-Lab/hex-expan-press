import { runLegacyHandler } from "../../_legacy/shim.ts";
import legacyHandler from "../../../../_legacy_handlers/esign/webhook.ts";

export const runtime = "nodejs";

/**
 * Next.js App Router entry for the esign webhook: bridges the legacy POST
 * handler that verifies the provider HMAC and advances the signing workflow
 * via processEsignWebhookUseCase. Invalid HMAC → 400; valid → 200.
 */
export async function POST(request: Request): Promise<Response> {
  return runLegacyHandler(request, legacyHandler);
}
