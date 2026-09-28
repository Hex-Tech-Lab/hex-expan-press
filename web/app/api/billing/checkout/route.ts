import { runLegacyHandler } from "../../_legacy/shim.ts";
import legacyHandler from "../../../../_legacy_handlers/billing/checkout.ts";

export const runtime = "nodejs";

/**
 * Next.js App Router entry for checkout: bridges the legacy GET/HEAD
 * handler that resolves a product's rail config and 302-redirects to the
 * selected provider checkout URL (MatrixRouter weighted distribution).
 */
export async function GET(request: Request): Promise<Response> {
  return runLegacyHandler(request, legacyHandler);
}
