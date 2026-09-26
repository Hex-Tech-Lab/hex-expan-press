import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { EnvSettingsAdapter } from "../../../src/adapters/settings/env_settings.adapter.ts";
import { createEsignEnvelopeUseCase } from "../../../src/use_cases/create_esign_envelope.ts";

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

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
  } catch (err: any) {
    console.error("Error creating esign envelope:", err);
    return json(res, 500, { ok: false, error: "Internal Server Error" });
  }
}
