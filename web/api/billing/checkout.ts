import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MatrixRouter } from "../../../src/infrastructure/matrix_router/matrix_router.ts";

interface CheckoutRail {
  provider: string;
  weight: number;
  checkout_url?: string;
}

interface RailsFile {
  product_id: string;
  rails: CheckoutRail[];
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export default async function handler(req: IncomingMessage & { query: Record<string, string | string[]> }, res: ServerResponse) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "Method Not Allowed" });
  }

  const product = typeof req.query.product === "string" ? req.query.product : Array.isArray(req.query.product) ? req.query.product[0] : "";

  if (!product) {
    return json(res, 400, { ok: false, error: "Missing product parameter in URL" });
  }

  let rails: CheckoutRail[];
  try {
    const file = path.join(process.cwd(), "data", "settings", `rails.${product}.json`);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const cfg = parsed as RailsFile;
    if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.rails) || cfg.rails.length === 0) {
      throw new Error("rails file has no usable rails array");
    }
    rails = cfg.rails;
  } catch {
    return json(res, 404, { ok: false, error: `No rails configuration found for product '${product}'` });
  }

  let providerName: string;
  try {
    // 10x Upgrade: Use MatrixRouter directly in the new clean namespace
    providerName = await MatrixRouter.getNextProvider("payments", product, rails);
  } catch (err) {
    console.error(`checkout: MatrixRouter failed, falling back to default rail: ${(err as Error).message}`);
    const fallback = [...rails].sort((a, b) => b.weight - a.weight).find((r) => typeof r.checkout_url === "string" && r.checkout_url !== "");
    if (!fallback) {
      return json(res, 503, { ok: false, error: `Router unavailable and no fallback rail configured: ${(err as Error).message}` });
    }
    res.statusCode = 302;
    res.setHeader("Location", fallback.checkout_url as string);
    res.end();
    return;
  }

  const rail = rails.find((r) => r.provider === providerName);
  const url = rail?.checkout_url;
  
  if (typeof url !== "string" || url === "") {
    return json(res, 503, { ok: false, error: `Rail '${providerName}' has no checkout_url configured` });
  }
  
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.end();
}
