import { runLegacyHandler } from "../../_legacy/shim.ts";
import legacyHandler from "../../../../_legacy_handlers/esign/create.ts";

export const runtime = "nodejs";

/**
 * Next.js App Router entry for esign envelope creation: bridges the legacy
 * POST handler (Supabase auth on the Authorization header, then
 * createEsignEnvelopeUseCase via the settings registry). 401 on missing or
 * invalid token, 400 on bad input.
 */
export async function POST(request: Request): Promise<Response> {
  return runLegacyHandler(request, legacyHandler);
}
