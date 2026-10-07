import { NextRequest, NextResponse } from "next/server";
import { MatrixRouter } from "../../../../../src/infrastructure/matrix_router/matrix_router";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import { getSupabaseAdmin } from "../../../../../payments/src/supabase_admin";
import { strictActiveConsentKinds } from "../../../../src/lib/consent-chain";


export const runtime = "nodejs";

interface CheckoutRail {
  provider: string;
  weight: number;
  checkout_url?: string;
}

/**
 * Billing checkout router (Wave 6, native route handler — replaces the
 * shim-bridged legacy handler; Sprint 15: rails come from the product_rails
 * table, not from repo JSON files). GET/HEAD only: resolves the product's
 * rail config from the Supabase product_rails table, a CHECKOUT_URL_<PRODUCT>
 * env override, or the built-in default launch rail, and 302-redirects to the
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

const SAFE_PRODUCT_RE = /^[a-zA-Z0-9_-]{2,80}$/;

// products.id is UUID-typed; a slug arm that isn't a UUID would make PostgREST
// reject the whole .or() filter (slug→uuid cast error), so the id arm is only
// added when the parameter actually IS a UUID.
const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

// Legacy launch slugs that predate the products table (duane_* carries
// underscores, which the slug CHECK `^[a-z0-9-]{2,80}$` forbids) — kept as a
// pinned id fallback, but they now go through the SAME consent gate.
const LEGACY_PRODUCT_IDS: Record<string, string> = {
  duane_retirement_playbook_v1: "57596c19-c550-4bde-b17a-e87b86d005c5",
  "retirearly500k-500k-playbook": "57596c19-c550-4bde-b17a-e87b86d005c5",
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const product = request.nextUrl.searchParams.get("product") ?? "";
  if (!product) return jsonError(400, "Missing product parameter in URL");

  // Sanitize product parameter to prevent Path Traversal / LFI (sprint 14 ARTAS Track A3)
  if (!SAFE_PRODUCT_RE.test(product) || product.includes("..") || product.includes("/") || product.includes("\\")) {
    return jsonError(400, "Invalid product parameter in URL");
  }

  // Active Consent Gate (sprint 14 ARTAS Track A1, CR-remediated fail-closed):
  // Checkout URL generation requires active C1, C2, and C3 consents for the
  // product. EVERY resolution failure is terminal — an unconfigured admin
  // client, a product lookup error, or an unresolved product all return 500
  // instead of skipping verification (ADR-0060: fail closed, never fail open).
  let dbRails: CheckoutRail[] = [];
  try {
    const supabase = await getSupabaseAdmin();
    if (!supabase) {
      console.error("[billing/checkout] Supabase admin client unavailable — consent gate cannot run, failing closed");
      return jsonError(500, "Checkout consent verification failed");
    }

    const productFilter = UUID_RE.test(product) ? `slug.eq.${product},id.eq.${product}` : `slug.eq.${product}`;
    const { data: dbProduct, error: prodErr } = await supabase
      .from("products")
      .select("id, creator_id")
      .or(productFilter)
      .maybeSingle();

    if (prodErr) {
      console.warn(`[billing/checkout] product lookup warning for '${product}': ${prodErr.message}`);
      return jsonError(500, "Checkout consent verification failed");
    }

    const resolvedProduct: { id: string; creator_id: string | null } | null =
      dbProduct ??
      (product in LEGACY_PRODUCT_IDS ? { id: LEGACY_PRODUCT_IDS[product], creator_id: null } : null);

    if (!resolvedProduct) {
      console.error(`[billing/checkout] product '${product}' did not resolve to a consent-verifiable product — failing closed`);
      return jsonError(500, "Checkout consent verification failed");
    }

    // Tenant isolation: the service-role client bypasses RLS, so the chain is
    // explicitly scoped to the product OWNER (creator_id — the schema column,
    // indexed). Legacy fallbacks resolve their owner by id; a product whose
    // owner cannot be determined has no chain to verify and fails closed.
    let ownerId: string | null = resolvedProduct.creator_id;
    if (!ownerId) {
      const { data: byIdProduct, error: byIdErr } = await supabase
        .from("products")
        .select("id, creator_id")
        .eq("id", resolvedProduct.id)
        .maybeSingle();
      if (byIdErr) {
        console.warn(`[billing/checkout] product owner lookup warning for '${product}': ${byIdErr.message}`);
        return jsonError(500, "Checkout consent verification failed");
      }
      ownerId = byIdProduct?.creator_id ?? null;
    }
    if (!ownerId) {
      console.error(`[billing/checkout] product owner unresolvable for '${product}' — failing closed`);
      return jsonError(500, "Checkout consent verification failed");
    }

    const { data: consentRows, error: consentErr } = await supabase
      .from("consents")
      .select("id, kind, decision, product_id, supersedes")
      .eq("creator_id", ownerId);

    if (consentErr) {
      console.error(`[billing/checkout] failed to query consents for '${product}': ${consentErr.message}`);
      return jsonError(500, "Checkout consent verification failed");
    }

    const active = strictActiveConsentKinds(consentRows ?? [], resolvedProduct.id);
    const hasC1 = active.has("C1_data_accuracy");
    const hasC2 = active.has("C2_release_approval");
    const hasC3 = active.has("C3_revenue_split");

    if (!hasC1 || !hasC2 || !hasC3) {
      console.error(`[billing/checkout] missing active consents for '${product}': C1=${hasC1}, C2=${hasC2}, C3=${hasC3}`);
      return jsonError(403, "Checkout forbidden: required creator consents are not active");
    }

    // Rails from the DATABASE (Sprint 15 heritage eradication — replaces the
    // data/settings/rails.<product>.json file read; product_rails is the SSOT).
    // The query fetches ALL configured rails (not just active ones): a product
    // with rails configured but NONE active is an explicit operator DISABLE —
    // it must return 404, never fall through to the env override / legacy
    // default rail below (only a product with NO rail records at all may fall
    // through). A rails query failure fails closed (500).
    const { data: railRows, error: railErr } = await supabase
      .from("product_rails")
      .select("provider, weight, checkout_url, active")
      .eq("product_id", resolvedProduct.id)
      .order("weight", { ascending: false });
    if (railErr) {
      console.error(`[billing/checkout] rails query failed for '${product}': ${railErr.message}`);
      return jsonError(500, "Checkout consent verification failed");
    }
    const allRails = (railRows ?? []).map((r) => ({
      provider: String((r as { provider: unknown }).provider),
      weight: Number((r as { weight: unknown }).weight),
      checkout_url: String((r as { checkout_url: unknown }).checkout_url),
      active: Boolean((r as { active: unknown }).active),
    }));
    dbRails = allRails.filter((r) => r.active).map(({ active: _active, ...rail }) => rail);
    // The disable guard counts only WELL-FORMED rows (real product_rails rows
    // are objects with an active boolean). A malformed row is a data-integrity
    // failure that the raw-URL validation below rejects with 500 — it must
    // never be misreported as an operator disable.
    const configuredRowCount = (railRows ?? []).filter((r) => r !== null && typeof r === "object").length;
    if (configuredRowCount > 0 && dbRails.length === 0) {
      console.error(`[billing/checkout] product '${product}' has ${configuredRowCount} configured rail(s) but none active — the database disable is authoritative`);
      return jsonError(404, `Checkout is disabled for product '${product}'`);
    }
  } catch (err) {
    console.error(`[billing/checkout] consent verification exception for '${product}': ${(err as Error).message}`);
    return jsonError(500, "Checkout consent verification failed");
  }

  let rails: CheckoutRail[];
  if (dbRails.length > 0) {
    rails = dbRails;
  } else {
    // No DB rails: the env override is the configured source, then the legacy
    // launch default, then 404. A SET override is the configured source even
    // when its raw value is blank — no trimming it away, no fall-through to
    // the default rail; the shared validator below rejects blank values with
    // the controlled 500.
    const envSlugKey = `CHECKOUT_URL_${product.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
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
