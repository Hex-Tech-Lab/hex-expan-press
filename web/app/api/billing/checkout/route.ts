import { NextRequest, NextResponse } from "next/server";
import { MatrixRouter } from "../../../../../src/infrastructure/matrix_router/matrix_router";
import { getSupabaseAdmin } from "../../../../../payments/src/supabase_admin";
import { GLOBAL, isEnabledPaymentProvider } from "../../../../../payments/src/settings_registry";
import { verifiedProviderNames } from "../webhook/verifiers";
import { attributionRef } from "../../../../src/lib/attribution";
import { normalizeSha256, strictActiveConsentKinds, strictChainHead } from "../../../../src/lib/consent-chain";
import { guidSchema, productRefSchema } from "../../../../src/lib/zod-rules";
import { MatrixRouterUnavailableError } from "../../../../../src/infrastructure/matrix_router/matrix_router_errors";


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
 * rail config from the Supabase product_rails table (no routable rail: 404;
 * a rail whose provider is switched off is not routed), and 302-redirects to the
 * weighted-selected provider checkout URL via MatrixRouter, falling back to
 * the highest-weight rail if the router fails. Every source's checkout_url
 * passes one validation policy — raw value must be a string (non-string
 * fails closed), then trimmed: non-empty, https, and sandbox hosts
 * (hostname label match) only in explicitly recognised non-production
 * environments when GLOBAL.payments.sandbox_checkout_enabled is true — and any
 * violation fails closed with 500 "Checkout is not configured".
 */
function jsonError(status: number, error: string, code?: string): NextResponse {
  return NextResponse.json({ ok: false, error, code }, { status });
}

type SupabaseAdmin = NonNullable<Awaited<ReturnType<typeof getSupabaseAdmin>>>;
type ProductRow = { id: string; creator_id: string | null; release_sha256?: string | null; checkout_mode?: string | null };
type ProductLookup = { product: ProductRow } | { response: NextResponse };

const PRODUCT_COLUMNS = "id, creator_id, release_sha256, checkout_mode";
const GATE_CONSENT_KINDS = ["C1_data_accuracy", "C2_release_approval", "C3_revenue_split"] as const;
const CONSENT_VERIFICATION_FAILED = "Checkout consent verification failed";

function lookupFailed(product: string, message: string): ProductLookup {
  console.warn(`[billing/checkout] product lookup warning for '${product}': ${message}`);
  return { response: jsonError(500, CONSENT_VERIFICATION_FAILED) };
}

function productNotFound(product: string): ProductLookup {
  console.error(`[billing/checkout] product '${product}' not found — failing closed`);
  return { response: jsonError(404, "Product not found", "product_not_found") };
}

/**
 * Resolves a product reference. ADR 0065: a product is identified by its creator's handle plus its product slug, and a
 * slug is unique per creator only.
 * - Product id (guid): resolves directly. The checkout page sends this form.
 * - Handle form `<handle>/<product_slug>`: resolves through the creator, so two creators may share a slug.
 * - Bare slug: never resolved, because the route must not guess which creator's product it means. Two or more
 *   matches answer 409 product_slug_ambiguous; one match answers 400 product_ref_requires_handle; none answers 404.
 */
async function lookupProduct(supabase: SupabaseAdmin, product: string): Promise<ProductLookup> {
  if (guidSchema.safeParse(product).success) {
    const { data, error } = await supabase.from("products").select(PRODUCT_COLUMNS).eq("id", product).maybeSingle();
    if (error) return lookupFailed(product, error.message);
    return data ? { product: data as ProductRow } : productNotFound(product);
  }

  if (product.includes("/")) {
    const [handle, slug] = product.split("/");
    const { data, error } = await supabase
      .from("products")
      .select(`${PRODUCT_COLUMNS}, creators!inner(handle)`)
      .eq("slug", slug)
      .eq("creators.handle", handle)
      .maybeSingle();
    if (error) return lookupFailed(product, error.message);
    return data ? { product: data as ProductRow } : productNotFound(product);
  }

  const { data: matches, error } = await supabase.from("products").select("id").eq("slug", product).limit(2);
  if (error) return lookupFailed(product, error.message);
  const count = (matches ?? []).length;
  if (count > 1) {
    console.error(`[billing/checkout] bare slug '${product}' matches ${count} creators' products — refusing to guess`);
    return { response: jsonError(409, "Product slug is shared by more than one creator. Use <handle>/<product_slug>.", "product_slug_ambiguous") };
  }
  if (count === 1) {
    return { response: jsonError(400, "A product slug alone does not identify a product. Use <handle>/<product_slug> or the product id.", "product_ref_requires_handle") };
  }
  return productNotFound(product);
}

function isNonProductionRuntime(): boolean {
  // Sandbox links only on explicitly recognised non-production runtimes; anything else (absent/unknown signals) fails closed.
  const v = process.env.VERCEL_ENV;
  if (v === "preview" || v === "development") return true;
  if (v) return false;
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

function sandboxAllowed(): boolean {
  // OWASP A04: preview/dev runtimes can share the production product_rails table, so sandbox
  // acceptance requires an explicit registry opt-in (default OFF) and is always false in production.
  if (!isNonProductionRuntime()) return false;
  return GLOBAL.payments?.sandbox_checkout_enabled === true;
}

// Attribution: only providers whose webhook reads reference_id back from the
// checkout-link query (Polar: metadata.reference_id) get it appended here.
// Paddle carries it in the overlay's customData (PaddleCheckoutButton), which
// a link query cannot set.
const REFERENCE_ID_PROVIDERS = new Set(["polar"]);

function withReference(checkoutUrl: string, provider: string, ref: string): string {
  if (!REFERENCE_ID_PROVIDERS.has(provider)) return checkoutUrl;
  const u = new URL(checkoutUrl);
  u.searchParams.set("reference_id", ref);
  return u.toString();
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
  if (labels.includes("sandbox")) return sandboxAllowed() ? null : "sandbox host not allowed";
  return null;
}


export async function GET(request: NextRequest): Promise<NextResponse> {
  const product = request.nextUrl.searchParams.get("product") ?? "";
  if (!product) return jsonError(400, "Missing product parameter in URL");

  // Sanitize product parameter to prevent Path Traversal / LFI (sprint 14 ARTAS Track A3)
  if (!productRefSchema.safeParse(product).success) {
    return jsonError(400, "Invalid product parameter in URL");
  }

  // Active Consent Gate (sprint 14 ARTAS Track A1, CR-remediated fail-closed):
  // Checkout URL generation requires active C1, C2, and C3 consents for the
  // product. Every resolution failure is terminal and never skips verification
  // (ADR-0060: fail closed, never fail open): an unconfigured admin client or a
  // product lookup error returns 500; an unresolved product returns 404; a bare
  // slug is refused with 409 or 400 (see lookupProduct).
  let dbRails: CheckoutRail[] = [];
  try {
    const supabase = await getSupabaseAdmin();
    if (!supabase) {
      console.error("[billing/checkout] Supabase admin client unavailable — consent gate cannot run, failing closed");
      return jsonError(500, "Checkout consent verification failed");
    }

    const lookup = await lookupProduct(supabase, product);
    if ("response" in lookup) return lookup.response;
    const resolvedProduct = lookup.product;

    // Launch state (Sprint 17): only a product the launch trigger let through
    // to 'live' may sell. 'sandbox' is honoured only outside production when
    // sandbox_checkout_enabled is true; 'gated', 'paddle', null or anything else fails closed.
    const mode = resolvedProduct.checkout_mode;
    if (mode !== "live" && !(mode === "sandbox" && sandboxAllowed())) {
      console.error(`[billing/checkout] product '${product}' is not launched (checkout_mode=${mode ?? "null"})`);
      return jsonError(403, "Checkout forbidden: product is not launched");
    }

    // Tenant isolation: the service-role client bypasses RLS, so the chain is
    // explicitly scoped to the product OWNER (creator_id — the schema column,
    // indexed). A product without an owner has no chain to verify.
    const ownerId = resolvedProduct.creator_id;
    if (!ownerId) {
      console.error(`[billing/checkout] product owner unresolvable for '${product}' — failing closed`);
      return jsonError(500, "Checkout consent verification failed");
    }

    // Only the three gate kinds decide checkout. Supersession is same-kind only, so narrowing the read to these
    // kinds leaves each kind's chain unchanged. The count below is taken on the same filtered query.
    const { data: consentRows, error: consentErr, count: consentCount } = await supabase
      .from("consents")
      .select("id, kind, decision, product_id, supersedes, supersedes_ids, document_sha256", { count: "exact" })
      .eq("creator_id", ownerId)
      .in("kind", GATE_CONSENT_KINDS);

    if (consentErr) {
      console.error(`[billing/checkout] failed to query consents for '${product}': ${consentErr.message}`);
      return jsonError(500, "Checkout consent verification failed");
    }
    // Supersession needs the COMPLETE chain: a response truncated by the
    // PostgREST row cap could omit a superseding refusal. Fail closed.
    if (typeof consentCount !== "number" || consentCount !== (consentRows ?? []).length) {
      console.error(`[billing/checkout] incomplete consent history for '${product}': got ${(consentRows ?? []).length} of ${consentCount ?? "unknown"}`);
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

    // Release integrity (Sprint 17): the active C2 head must have approved the
    // product's CURRENT release PDF. A missing/invalid hash on either side or a
    // mismatch fails closed — the same check the launch trigger enforces.
    const releaseSha = normalizeSha256(resolvedProduct.release_sha256);
    const c2Head = strictChainHead(consentRows ?? [], resolvedProduct.id, "C2_release_approval");
    const approvedSha = normalizeSha256(c2Head?.document_sha256);
    if (!releaseSha || !approvedSha || approvedSha !== releaseSha) {
      console.error(`[billing/checkout] release hash mismatch for '${product}': release=${releaseSha ?? "invalid"} approved=${approvedSha ?? "invalid"}`);
      return jsonError(403, "Checkout forbidden: release hash mismatch");
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
    // Checked before the map below, which would throw on a null row. A non-object row is a
    // data-integrity failure: never an operator disable, never a silent fallthrough (fail closed).
    if ((railRows ?? []).some((r) => r === null || typeof r !== "object")) {
      console.error(`[billing/checkout] product '${product}' has a malformed product_rails row — failing closed`);
      return jsonError(500, "Checkout is not configured");
    }
    // Raw values are kept as read (no String()/Boolean() coercion: String(null) is "null", Boolean("false")
    // is true). Only boolean true or the string "true" enables a rail; anything else is off.
    const allRails = (railRows ?? []).map((r) => {
      const row = r as { provider: unknown; weight: unknown; checkout_url: unknown; active: unknown };
      return {
        provider: row.provider,
        weight: Number(row.weight),
        checkout_url: row.checkout_url,
        active: row.active === true || row.active === "true",
      };
    });
    // Active rails must carry a non-empty provider and a string checkout_url, checked on the raw value.
    // A null or non-string URL on a live rail fails closed here, not via a stringified "null".
    const activeRaw = allRails.filter((r) => r.active);
    if (activeRaw.some((r) => typeof r.provider !== "string" || r.provider === "" || typeof r.checkout_url !== "string")) {
      console.error(`[billing/checkout] product '${product}' has an active rail with a missing provider or non-string checkout_url — failing closed`);
      return jsonError(500, "Checkout is not configured");
    }
    // Runtime-checked above; the cast only drops the `active` flag from the shape.
    // A rail can take a buyer only if its provider is switched on AND has a verifier (a rail that cannot be verified
    // would refuse its own webhooks). The launch switch decides the first condition: an active row for a switched-off provider
    // is dropped here, so a product whose only active rows are switched off fails closed through the
    // disable guard below.
    const verified = verifiedProviderNames();
    dbRails = activeRaw
      .filter((r) => typeof r.provider === "string" && isEnabledPaymentProvider(r.provider) && verified.has(r.provider))
      .map((r) => {
        const rail: Record<string, unknown> = { ...r };
        delete rail.active; // the active flag is not part of a checkout rail
        return rail as unknown as CheckoutRail;
      });
    // The disable guard counts only WELL-FORMED rows (real product_rails rows
    // are objects). A malformed row is a data-integrity failure: an active one
    // is rejected with 500 by the active-rail check above, and it must never be
    // misreported as an operator disable.
    const configuredRowCount = (railRows ?? []).filter((r) => r !== null && typeof r === "object").length;

    if (configuredRowCount > 0 && dbRails.length === 0) {
      console.error(`[billing/checkout] product '${product}' has ${configuredRowCount} configured rail(s) but none usable (not active, or provider switched off) — refusing checkout`);
      return jsonError(404, `Checkout is disabled for product '${product}'`);
    }
  } catch (err) {
    console.error(`[billing/checkout] consent verification exception for '${product}': ${(err as Error).message}`);
    return jsonError(500, "Checkout consent verification failed");
  }

  // No routable DB rails: fail closed. There is no CHECKOUT_URL_<PRODUCT> override and no Polar fallback (PR 102).
  if (dbRails.length === 0) {
    return jsonError(404, `No rails configuration found for product '${product}'`);
  }
  const rails: CheckoutRail[] = dbRails;


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
    // Every rail is marked down by the circuit breaker: answer unavailable. Falling back to the highest-weight rail
    // here would route a buyer to a rail the breaker has taken out (Argon F-16).
    if (err instanceof MatrixRouterUnavailableError) {
      console.error(`[billing/checkout] every rail is marked down for '${product}' — answering 503`);
      return jsonError(503, "Checkout is temporarily unavailable. No payment rail is accepting orders.", "rails_unavailable");
    }
    console.error(`checkout: MatrixRouter failed, falling back to default rail: ${(err as Error).message}`);
    const fallback = [...rails].sort((lhs, rhs) => rhs.weight - lhs.weight).find((r) => typeof r.checkout_url === "string" && r.checkout_url !== "");
    if (!fallback) {
      console.error(`[billing/checkout] Router unavailable and no fallback rail configured for '${product}': ${(err as Error).message}`);
      return jsonError(503, "Checkout is temporarily unavailable");
    }
    const res = NextResponse.redirect(withReference(fallback.checkout_url as string, fallback.provider, attributionRef((p) => request.nextUrl.searchParams.get(p))), 302);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  const rail = rails.find((r) => r.provider === providerName);
  if (!rail?.checkout_url) return jsonError(503, `Selected rail '${providerName}' has no checkout_url`);
  const res = NextResponse.redirect(withReference(rail.checkout_url, rail.provider, attributionRef((p) => request.nextUrl.searchParams.get(p))), 302);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function HEAD(request: NextRequest): Promise<NextResponse> {
  // HEAD mirrors GET status semantics without a body — legacy contract kept.
  const res = await GET(request);
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
