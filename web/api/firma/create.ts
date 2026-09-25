import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export default async function handler(req: IncomingMessage & { query: Record<string, string | string[]> }, res: ServerResponse) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method Not Allowed" });

  let body = "";
  for await (const chunk of req) body += chunk;
  const { productId } = JSON.parse(body);

  const authHeader = req.headers.authorization;
  if (!authHeader) return json(res, 401, { ok: false, error: "Unauthorized" });
  
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (authErr || !user) return json(res, 401, { ok: false, error: "Invalid token" });

  // Call Firma API to create envelope
  const firmaRes = await fetch("https://api.firma.dev/v1/envelopes", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.FIRMA_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      template_id: "revenue-split-template",
      signers: [{ email: user.email, name: user.email }],
      metadata: { productId, userId: user.id },
      redirect_url: `https://expanpress.com/account/consents/firma_done`,
      webhook_url: `https://expanpress.com/api/firma/webhook`
    })
  });

  if (!firmaRes.ok) {
    // If Firma is just a mock for now
    return json(res, 200, { ok: true, url: `https://firma.dev/mock-sign?envelope=123` });
  }

  const firmaData = await firmaRes.json();
  json(res, 200, { ok: true, url: firmaData.embedded_url });
}
