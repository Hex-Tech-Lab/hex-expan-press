import { appendBrowser } from "@/lib/store";
import { MAX_BODY_BYTES, validate, verifySignature } from "@/lib/ingest";

// Receives browser-measurement summaries (sitespeed.io, WebPageTest). Signed with PROBE_INGEST_SECRET.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.PROBE_INGEST_SECRET;
  if (!secret) return json({ error: "ingest_not_configured" }, 503);

  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413);
  // Signature is checked on the exact bytes received, before any parsing.
  if (!verifySignature(raw, req.headers.get("x-probe-signature"), secret)) return json({ error: "unauthorized" }, 401);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "malformed_json" }, 400);
  }
  const v = validate(parsed, Date.now());
  if (!v.ok) return json({ error: "invalid_body", reason: v.error }, 400);

  await appendBrowser(v.value);
  return json({ ok: true }, 202);
}
