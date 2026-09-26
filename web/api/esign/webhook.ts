import type { IncomingMessage, ServerResponse } from "node:http";
import { EnvSettingsAdapter } from "../../../src/adapters/settings/env_settings.adapter.ts";
import { SupabaseAdapter } from "../../../src/adapters/database/supabase.adapter.ts";
import { processEsignWebhookUseCase } from "../../../src/use_cases/process_esign_webhook.ts";

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method Not Allowed" });

  try {
    let body = "";
    for await (const chunk of req) body += chunk;

    const settingsRegistry = new EnvSettingsAdapter();
    const database = new SupabaseAdapter();

    const ip = (req.headers["x-forwarded-for"] as string) || "0.0.0.0";
    const userAgent = req.headers["user-agent"] || "";

    await processEsignWebhookUseCase(
      {
        body,
        headers: req.headers,
        ip,
        userAgent
      },
      settingsRegistry,
      database
    );

    return json(res, 200, { ok: true });
  } catch (err: any) {
    console.error("Error processing esign webhook:", err);
    // Even on error we often want to return 200 or 400 depending on if it's a provider issue vs bad data.
    // 400 will tell the provider to retry if they support it.
    const isValidationErr = err.message.includes("validation failed");
    return json(res, isValidationErr ? 400 : 500, { ok: false, error: isValidationErr ? "Bad Request" : "Internal Server Error" });
  }
}
