import { runLegacyHandler } from "../../_legacy/shim.ts";
import legacyHandler from "../../../../_legacy_handlers/billing/webhook.ts";

export const runtime = "nodejs";

/**
 * Next.js App Router entry for the billing webhook: bridges the legacy
 * Vercel handler (Polar/Paddle/legacy-provider signature verification and
 * ledger recording) via the req/res shim. Called by providers with
 * signed POSTs; responses follow the legacy status contract (200/400/500).
 */
export async function POST(request: Request): Promise<Response> {
  return runLegacyHandler(request, legacyHandler);
}
