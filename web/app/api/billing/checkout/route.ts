import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { MatrixRouter } from "../../../../../src/infrastructure/matrix_router/matrix_router";
import { GLOBAL } from "../../../../../payments/src/settings_registry";

export const runtime = "nodejs";

interface CheckoutRail {
  provider: string;
  weight: number;
  checkout_url?: string;
}

/**
 * Billing checkout router (Wave 6, native route handler — replaces the
 * shim-bridged legacy handler). GET/HEAD only: resolves the product's rail
 * config from the repo data/ file, a CHECKOUT_URL_<PRODUCT> env override, or
 * the built-in default launch rail, and 302-redirects to the
 * weighted-selected provider checkout URL via MatrixRouter, falling back to
 * the highest-weight rail if the router fails. Every source's checkout_url
 * passes one validation policy — raw value must be a string (non-string
 * fails closed), then trimmed: non-empty, https, and sandbox hosts
 * (hostname label match) only in explicitly recognised non-production
 * environments — and any violation (including an unset POLAR_CHECKOUT_URL
 * for the default rail in production, or a SET-but-blank
 * CHECKOUT_URL_<PRODUCT> override) fails closed with 500 "Checkout is not
 * configured".
 */
function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

function sandboxAllowed(): boolean {
  // Sandbox links only on explicitly recognised non-production runtimes; anything else (absent/unknown signals) fails closed.
  const v = process.env.VERCEL_ENV;
  if (v === "preview" || v === "development") return true;
  if (v) return false;
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

function checkoutUrlProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return "missing";
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "malformed";
  }
  if (u.protocol !== "https:") return "not https";
  const labels = u.hostname.toLowerCase().split(/[.-]/);
  if (labels.includes("sandbox")) return sandboxAllowed() ? null : "sandbox host in production";
  return null;
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
    // A SET override is the configured source even when its raw value is
    // blank — no trimming it away, no fall-through to the default rail; the
    // shared validator below rejects blank values with the controlled 500.
    const overrideUrl = process.env[envSlugKey];
    if (overrideUrl !== undefined) {
      rails = [{ provider: "polar", weight: 100, checkout_url: overrideUrl }];
    } else if (product === "retirearly500k-500k-playbook" || product === "duane_retirement_playbook_v1") {
      const liveCheckoutUrl = process.env.POLAR_CHECKOUT_URL?.trim();
      if (!liveCheckoutUrl && !sandboxAllowed()) {
        // Fail closed: never send a real buyer to the sandbox checkout (insecure-defaults audit, 2026-10-01).
        console.error("[billing/checkout] POLAR_CHECKOUT_URL is not set and sandbox is not allowed here — refusing to serve the sandbox checkout");
        return jsonError(500, "Checkout is not configured");
      }
      rails = [
        {
          provider: "polar",
          weight: 100,
          checkout_url: liveCheckoutUrl || GLOBAL.payments.polar.sandbox_checkout_fallback_url,
        },
      ];
    } else {
      return jsonError(404, `No rails configuration found for product '${product}'`);
    }
  }

  // Fail closed on non-string RAW checkout_url values (missing/null/number
  // from a malformed rails file) BEFORE any trimming — no silent rail skips.
  for (const rail of rails) {
    if (!rail || typeof rail !== "object" || typeof rail.checkout_url !== "string") {
      console.error(`[billing/checkout] rejected checkout_url for '${product}' (${rail?.provider ?? "unknown"}): missing or not a string`);
      return jsonError(500, "Checkout is not configured");
    }
  }

  // One URL policy for every source: validate before routing, redirect trimmed.
  for (const rail of rails) {
    rail.checkout_url = (rail.checkout_url as string).trim();
    const problem = checkoutUrlProblem(rail.checkout_url);
    if (problem) {
      console.error(`[billing/checkout] rejected checkout_url for '${product}' (${rail.provider}): ${problem}`);
      return jsonError(500, "Checkout is not configured");
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
