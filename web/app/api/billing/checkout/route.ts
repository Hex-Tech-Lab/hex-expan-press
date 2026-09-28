import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { MatrixRouter } from "../../../../../src/infrastructure/matrix_router/matrix_router";

export const runtime = "nodejs";

interface CheckoutRail {
  provider: string;
  weight: number;
  checkout_url?: string;
}

/**
 * Billing checkout router (Wave 6, native route handler — replaces the
 * shim-bridged legacy handler). GET/HEAD only: resolves the product's rail
 * config (repo data/ file, env override, or built-in default rail for the
 * launch product in serverless) and 302-redirects to the weighted-selected
 * provider checkout URL via MatrixRouter.
 */
function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const product = request.nextUrl.searchParams.get("product") ?? "";
  if (!product) return jsonError(400, "Missing product parameter in URL");

  let rails: CheckoutRail[];
  const file = path.join(process.cwd(), "data", "settings", `rails.${product}.json`);
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const cfg = parsed as RailsFile;
    if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.rails) || cfg.rails.length === 0) {
      throw new Error("rails file has no usable rails array");
    }
    rails = cfg.rails;
  } catch (err) {
    // Serverless fallback: data/ is not bundled on Vercel, so the file being
    // ABSENT is the normal path (silent); log only when a file exists but
    // was unusable — that is a real misconfiguration.
    if (existsSync(file)) {
      console.error(`[billing/checkout] unusable rails file for '${product}': ${(err as Error).message}`);
    }
    const envSlugKey = `CHECKOUT_URL_${product.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const dynamicCheckoutUrl = process.env[envSlugKey];
    if (dynamicCheckoutUrl) {
      rails = [{ provider: "polar", weight: 100, checkout_url: dynamicCheckoutUrl }];
    } else if (product === "retirearly500k-500k-playbook" || product === "duane_retirement_playbook_v1") {
      rails = [
        {
          provider: "polar",
          weight: 100,
          checkout_url: process.env.POLAR_CHECKOUT_URL || "https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_g84ByoGAeZiahkWtCasYmeu1ShLtZIwwayzyI4ZdZsM/redirect",
        },
      ];
    } else {
      return jsonError(404, `No rails configuration found for product '${product}'`);
    }
  }

  let providerName: string;
  try {
    providerName = await MatrixRouter.getNextProvider("payments", product, rails);
  } catch (err) {
    console.error(`checkout: MatrixRouter failed, falling back to default rail: ${(err as Error).message}`);
    const fallback = [...rails].sort((lhs, rhs) => rhs.weight - lhs.weight).find((r) => typeof r.checkout_url === "string" && r.checkout_url !== "");
    if (!fallback) {
      return jsonError(503, `Router unavailable and no fallback rail configured: ${(err as Error).message}`);
    }
    return NextResponse.redirect(fallback.checkout_url as string, 302);
  }

  const rail = rails.find((r) => r.provider === providerName);
  if (!rail?.checkout_url) return jsonError(503, `Selected rail '${providerName}' has no checkout_url`);
  return NextResponse.redirect(rail.checkout_url, 302);
}

export async function HEAD(request: NextRequest): Promise<NextResponse> {
  // HEAD mirrors GET status semantics without a body — legacy contract kept.
  const res = await GET(request);
  return new NextResponse(null, { status: res.status, headers: res.headers });
}

interface RailsFile {
  product_id: string;
  rails: CheckoutRail[];
}
