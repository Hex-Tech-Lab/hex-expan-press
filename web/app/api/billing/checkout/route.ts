import { runLegacyHandler } from "../../_legacy/shim.ts";
import legacyHandler from "../../../../api/billing/checkout.ts";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return runLegacyHandler(request, legacyHandler);
}
