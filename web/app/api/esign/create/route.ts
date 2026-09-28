import { runLegacyHandler } from "../../_legacy/shim.ts";
import legacyHandler from "../../../../api/esign/create.ts";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return runLegacyHandler(request, legacyHandler);
}
