import { runLegacyHandler } from "../../_legacy/shim.ts";
import legacyHandler from "../../../../api/esign/webhook.ts";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return runLegacyHandler(request, legacyHandler);
}
