import { NextRequest, NextResponse } from "next/server";
import { EnvSettingsAdapter } from "../../../../../src/adapters/settings/env_settings.adapter";
import { SupabaseAdapter } from "../../../../../src/adapters/database/supabase.adapter";
import { processEsignWebhookUseCase } from "../../../../../src/use_cases/process_esign_webhook";
import { WebhookValidationError } from "../../../../../src/domain/webhook/webhook_errors";

export const runtime = "nodejs";

// Same 1 MiB cap as the billing webhook (Wave 4 contract).
const MAX_BODY_BYTES = 1_048_576;

async function readBodyCapped(request: NextRequest): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * E-sign webhook (Wave 6, native route handler — replaces the shim-bridged
 * legacy handler). Firma HMAC verification is fail-closed (Wave 5.1): an
 * unconfigured FIRMA_WEBHOOK_SECRET rejects, never skips validation.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const bodyBuffer = await readBodyCapped(request);
  if (bodyBuffer === null) {
    return NextResponse.json({ ok: false, error: "Payload Too Large" }, { status: 413 });
  }
  const body = bodyBuffer.toString("utf8");

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "0.0.0.0";
  const userAgent = request.headers.get("user-agent") ?? "";

  try {
    // Constructed inside the failure boundary: a missing SUPABASE_* env must give a
    // controlled 500 (Firma retries), not an unhandled crash (HEX-EXPAN-PRESS-2).
    const settingsRegistry = new EnvSettingsAdapter();
    const database = new SupabaseAdapter();
    await processEsignWebhookUseCase({ body, headers: Object.fromEntries(request.headers), ip, userAgent }, settingsRegistry, database);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Error processing esign webhook:", err);
    const message = err instanceof Error ? err.message : String(err);
    // Typed classification first (sprint-10 F5): error prose is no longer
    // load-bearing. The substring check below is a deprecated fallback kept
    // one release for any legacy error path that still classifies by prose.
    let status: number;
    if (err instanceof WebhookValidationError) {
      status = err.httpStatus;
    } else if (message.includes("validation failed")) {
      status = 400;
    } else {
      status = 500;
    }
    return NextResponse.json(
      { ok: false, error: status === 500 ? "Internal Server Error" : "Bad Request" },
      { status },
    );
  }
}
