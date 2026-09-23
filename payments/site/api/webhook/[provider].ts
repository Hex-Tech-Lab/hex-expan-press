import type { IncomingMessage, ServerResponse } from "node:http";
import { handleWebhookPayload } from "../../../src/webhook_core.ts";

export const config = {
  api: {
    bodyParser: false, // Need raw body for HMAC signature verification
  },
};

async function getRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: IncomingMessage & { query: Record<string, string | string[]> }, res: ServerResponse) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    return;
  }

  const provider = typeof req.query.provider === "string" ? req.query.provider : Array.isArray(req.query.provider) ? req.query.provider[0] : "";

  if (!provider) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Missing provider parameter in URL" }));
    return;
  }

  try {
    const rawBody = await getRawBody(req);
    const result = await handleWebhookPayload(provider, req.headers, rawBody);

    res.statusCode = result.status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result.payload));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}
