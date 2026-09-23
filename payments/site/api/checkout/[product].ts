import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { nextRail, type RailWeight } from "../../../src/provider_router.ts";

type CheckoutRail = RailWeight & { checkout_url?: string };

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
    json(res, 405, { ok: false, error: "Method Not Allowed" });
    return;
  }

  const product = typeof req.query.product === "string" ? req.query.product : Array.isArray(req.query.product) ? req.query.product[0] : "";

  if (!product) {
    json(res, 400, { ok: false, error: "Missing product parameter in URL" });
    return;
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
    json(res, 404, { ok: false, error: `No rails configuration found for product '${product}'` });
    return;
  }

  let provider: string;
  try {
    provider = await nextRail(product, rails);
  } catch (err) {
    // Redis unavailable/timed out (or any other router error): fall back to the
    // highest-weight rail with a usable checkout_url rather than failing the request.
    console.error(`checkout: nextRail(${product}) failed, falling back to default rail: ${(err as Error).message}`);
    const fallback = [...rails].sort((a, b) => b.weight - a.weight).find((r) => typeof r.checkout_url === "string" && r.checkout_url !== "");
    if (!fallback) {
      json(res, 503, { ok: false, error: `Router unavailable and no fallback rail configured: ${(err as Error).message}` });
      return;
    }
    res.statusCode = 302;
    res.setHeader("Location", fallback.checkout_url as string);
    res.end();
    return;
  }

  const rail = rails.find((r) => r.provider === provider);
  const url = rail?.checkout_url;
  if (typeof url !== "string" || url === "") {
    json(res, 503, { ok: false, error: `Rail '${provider}' has no checkout_url configured` });
    return;
  }
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.end();
}
