import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { EnvSettingsAdapter } from "../../../src/adapters/settings/env_settings.adapter.ts";
import { createEsignEnvelopeUseCase } from "../../../src/use_cases/create_esign_envelope.ts";

/**
 * Writes a JSON response through the legacy Node ServerResponse surface.
 */
function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

/**
 * Legacy Vercel esign-envelope creation handler (bridged into Next.js via
 * shim.ts): authenticates the caller via Supabase using the Authorization
 * Bearer token, then creates the Firma envelope for the requested product.
 * 405 non-POST, 401 missing/invalid token, 400 bad input.
 */
export default async function handler(req: IncomingMessage & { query: Record<string, string | string[]> }, res: ServerResponse) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method Not Allowed" });

  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { productId } = JSON.parse(body);

    const authHeader = req.headers.authorization;
    if (!authHeader) return json(res, 401, { ok: false, error: "Unauthorized" });
    
    // Auth validation via Supabase
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authErr || !user) return json(res, 401, { ok: false, error: "Invalid token" });

    // Host resolution (handle local vs production Vercel environments)
    const host = req.headers.host || "expanpress.com";
    const protocol = host.includes("localhost") ? "http" : "https";
    const hostUrl = `${protocol}://${host}`;

    // Execute application use case
    const settingsRegistry = new EnvSettingsAdapter();
    const result = await createEsignEnvelopeUseCase({
      productId,
      userId: user.id,
      userEmail: user.email!,
      hostUrl
    }, settingsRegistry);

    return json(res, 200, { ok: true, url: result.signUrl });
  } catch (err) {
    console.error("Error creating esign envelope:", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (/insufficient credits|402/i.test(msg)) {
      return json(res, 503, { ok: false, error: "The signing service is awaiting credit activation. Please try again shortly." });
    }
    return json(res, 500, { ok: false, error: "Internal Server Error" });
  }
}
