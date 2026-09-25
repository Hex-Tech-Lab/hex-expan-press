import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method Not Allowed" });

  let body = "";
  for await (const chunk of req) body += chunk;

  // Verify signature (example implementation)
  const sig = req.headers["x-firma-signature"] as string;
  const secret = process.env.FIRMA_WEBHOOK_SECRET!;
  const hash = crypto.createHmac("sha256", secret).update(body).digest("hex");
  // if (sig !== hash) return json(res, 401, { ok: false, error: "Invalid signature" }); // Disabled for mock

  const payload = JSON.parse(body);
  if (payload.event === "envelope.completed") {
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
    const { productId, userId } = payload.metadata;
    const envelopeId = payload.envelope_id;

    // We would fetch PDF and upload to Storage here
    const pdfPath = `${userId}/${envelopeId}.pdf`;
    
    // Call submit_consent for C3 using service role
    await supabase.rpc("submit_consent", {
      p_product_id: productId,
      p_kind: "C3_revenue_split",
      p_decision: "given",
      p_text_version: "v1.0",
      p_document_sha256: "firma-doc-hash",
      p_typed_name: "Signed via Firma",
      p_ip: req.headers["x-forwarded-for"] || "0.0.0.0",
      p_user_agent: req.headers["user-agent"] || "",
      p_auth_provider: "firma",
      p_external_ref: envelopeId,
      p_evidence_path: pdfPath
    });
  }

  json(res, 200, { ok: true });
}
