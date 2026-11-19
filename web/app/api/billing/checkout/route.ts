import { NextRequest, NextResponse } from "next/server";
import { MatrixRouter } from "../../../../../src/infrastructure/matrix_router/matrix_router";
import { getSupabaseAdmin } from "../../../../../payments/src/supabase_admin";
import { isEnabledPaymentProvider } from "../../../../../payments/src/settings_registry";
import { verifiedProviderNames } from "../webhook/verifiers";
import { normalizeSha256, strictActiveConsentKinds, strictChainHead } from "../../../../src/lib/consent-chain";
import { guidSchema, productRefSchema } from "../../../../src/lib/zod-rules";
import { MatrixRouterUnavailableError } from "../../../../../src/infrastructure/matrix_router/matrix_router_errors";
import {
  buildAttributionRef,
  buildCheckoutRedirectUrl,
  buyerCountryError,
  checkoutUrlProblem,
  creatorHandleOf,
  jsonError,
  parseBuyerQuery,
  parsePostBody,
  type CheckoutRail,
  type ParsedCheckoutRequest,
  type ProductRow,
} from "./checkout-helpers";

export const runtime = "nodejs";

type SupabaseAdmin = NonNullable<Awaited<ReturnType<typeof getSupabaseAdmin>>>;
type ProductLookup = { product: ProductRow } | { response: NextResponse };

const PRODUCT_COLUMNS = "id, store_product_id, creator_id, release_sha256, checkout_mode";
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

async function lookupProduct(supabase: SupabaseAdmin, product: string): Promise<ProductLookup> {
  if (guidSchema.safeParse(product).success) {
    const { data, error } = await supabase
      .from("products")
      .select(`${PRODUCT_COLUMNS}, creators(handle)`)
      .eq("id", product)
      .maybeSingle();
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

async function handleCheckout(
  request: NextRequest,
  parsed: ParsedCheckoutRequest,
  redirectStatus: 302 | 303,
): Promise<NextResponse> {
  const geoErr = buyerCountryError(request);
  if (geoErr) return geoErr;

  const { product, buyer, getAttr } = parsed;
  if (!product) return jsonError(400, "Missing product parameter in URL");

  if (!productRefSchema.safeParse(product).success) {
    return jsonError(400, "Invalid product parameter in URL");
  }

  if (!buyer.ok) return jsonError(400, buyer.error, buyer.code);

  let dbRails: CheckoutRail[] = [];
  let resolvedProduct: ProductRow;
  try {
    const supabase = await getSupabaseAdmin();
    if (!supabase) {
      console.error("[billing/checkout] Supabase admin client unavailable — consent gate cannot run, failing closed");
      return jsonError(500, CONSENT_VERIFICATION_FAILED);
    }

    const lookup = await lookupProduct(supabase, product);
    if ("response" in lookup) return lookup.response;
    resolvedProduct = lookup.product;

    const mode = resolvedProduct.checkout_mode;
    const { sandboxAllowed } = await import("./checkout-helpers");
    if (mode !== "live" && !(mode === "sandbox" && sandboxAllowed())) {
      console.error(`[billing/checkout] product '${product}' is not launched (checkout_mode=${mode ?? "null"})`);
      return jsonError(403, "Checkout forbidden: product is not launched");
    }

    const ownerId = resolvedProduct.creator_id;
    if (!ownerId) {
      console.error(`[billing/checkout] product owner unresolvable for '${product}' — failing closed`);
      return jsonError(500, CONSENT_VERIFICATION_FAILED);
    }

    const { data: consentRows, error: consentErr, count: consentCount } = await supabase
      .from("consents")
      .select("id, kind, decision, product_id, supersedes, supersedes_ids, document_sha256", { count: "exact" })
      .eq("creator_id", ownerId)
      .in("kind", GATE_CONSENT_KINDS);

    if (consentErr) {
      console.error(`[billing/checkout] failed to query consents for '${product}': ${consentErr.message}`);
      return jsonError(500, CONSENT_VERIFICATION_FAILED);
    }
    if (typeof consentCount !== "number" || consentCount !== (consentRows ?? []).length) {
      console.error(`[billing/checkout] incomplete consent history for '${product}': got ${(consentRows ?? []).length} of ${consentCount ?? "unknown"}`);
      return jsonError(500, CONSENT_VERIFICATION_FAILED);
    }

    const rows = consentRows ?? [];
    const active = strictActiveConsentKinds(rows, resolvedProduct.id);
    const hasC1 = active.has("C1_data_accuracy");
    const hasC2 = active.has("C2_release_approval");
    const hasC3 = active.has("C3_revenue_split");

    if (!hasC1 || !hasC2 || !hasC3) {
      console.error(`[billing/checkout] missing active consents for '${product}': C1=${hasC1}, C2=${hasC2}, C3=${hasC3}`);
      return jsonError(403, "Checkout forbidden: required creator consents are not active");
    }

    const releaseSha = normalizeSha256(resolvedProduct.release_sha256);
    const c2Head = strictChainHead(rows, resolvedProduct.id, "C2_release_approval");
    const approvedSha = normalizeSha256(c2Head?.document_sha256);
    if (!releaseSha || !approvedSha || approvedSha !== releaseSha) {
      console.error(`[billing/checkout] release hash mismatch for '${product}': release=${releaseSha ?? "invalid"} approved=${approvedSha ?? "invalid"}`);
      return jsonError(403, "Checkout forbidden: release hash mismatch");
    }

    const { data: railRows, error: railErr } = await supabase
      .from("product_rails")
      .select("provider, weight, checkout_url, active")
      .eq("product_id", resolvedProduct.id)
      .order("weight", { ascending: false });
    if (railErr) {
      console.error(`[billing/checkout] rails query failed for '${product}': ${railErr.message}`);
      return jsonError(500, CONSENT_VERIFICATION_FAILED);
    }
    if ((railRows ?? []).some((r) => r === null || typeof r !== "object")) {
      console.error(`[billing/checkout] product '${product}' has a malformed product_rails row — failing closed`);
      return jsonError(500, "Checkout is not configured");
    }
    const allRails = (railRows ?? []).map((r) => {
      const row = r as { provider: unknown; weight: unknown; checkout_url: unknown; active: unknown };
      return {
        provider: row.provider,
        weight: Number(row.weight),
        checkout_url: row.checkout_url,
        active: row.active === true || row.active === "true",
      };
    });
    const activeRaw = allRails.filter((r) => r.active);
    const activeValid: CheckoutRail[] = [];
    for (const r of activeRaw) {
      if (
        typeof r.provider !== "string" ||
        r.provider === "" ||
        typeof r.checkout_url !== "string" ||
        !Number.isFinite(r.weight) ||
        r.weight < 0
      ) {
        console.error(`[billing/checkout] product '${product}' has an active rail with a missing provider or non-string checkout_url — failing closed`);
        return jsonError(500, "Checkout is not configured");
      }
      activeValid.push({
        provider: r.provider,
        weight: r.weight,
        checkout_url: r.checkout_url,
      });
    }
    const verified = verifiedProviderNames();
    dbRails = activeValid.filter((r) => isEnabledPaymentProvider(r.provider) && verified.has(r.provider));
    const configuredRowCount = (railRows ?? []).length;

    if (configuredRowCount > 0 && dbRails.length === 0) {
      console.error(`[billing/checkout] product '${product}' has ${configuredRowCount} configured rail(s) but none usable (not active, or provider switched off) — refusing checkout`);
      return jsonError(404, `Checkout is disabled for product '${product}'`);
    }
  } catch (err) {
    console.error(`[billing/checkout] consent verification exception for '${product}': ${(err as Error).message}`);
    return jsonError(500, CONSENT_VERIFICATION_FAILED);
  }

  if (dbRails.length === 0) {
    return jsonError(404, `No rails configuration found for product '${product}'`);
  }
  const rails: CheckoutRail[] = dbRails;

  for (const rail of rails) {
    rail.checkout_url = rail.checkout_url.trim();
    const problem = checkoutUrlProblem(rail.checkout_url, resolvedProduct.checkout_mode);
    if (problem) {
      console.error(`[billing/checkout] rejected checkout_url for '${product}' (${rail.provider}): ${problem}`);
      return jsonError(500, "Checkout is not configured");
    }
  }

  const attribution = buildAttributionRef(getAttr);
  const creatorHandle = creatorHandleOf(resolvedProduct, product);

  let selectedRail: CheckoutRail | undefined;
  try {
    const providerName = await MatrixRouter.getNextProvider("payments", resolvedProduct.id, rails);
    selectedRail = rails.find((r) => r.provider === providerName);
    if (!selectedRail?.checkout_url) {
      console.error(`[billing/checkout] selected rail '${providerName}' has no checkout_url`);
      return jsonError(503, "Checkout is temporarily unavailable");
    }
  } catch (err) {
    if (err instanceof MatrixRouterUnavailableError) {
      console.error(`[billing/checkout] every rail is marked down for '${product}' — answering 503`);
      return jsonError(503, "Checkout is temporarily unavailable. No payment rail is accepting orders.", "rails_unavailable");
    }
    console.error(`checkout: MatrixRouter failed, falling back to default rail: ${(err as Error).message}`);
    selectedRail = [...rails].sort((lhs, rhs) => rhs.weight - lhs.weight)[0];
  }

  const redirectUrl = buildCheckoutRedirectUrl(selectedRail, resolvedProduct, creatorHandle, attribution, buyer.value);
  const res = NextResponse.redirect(redirectUrl, redirectStatus);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export function GET(request: NextRequest): Promise<NextResponse> {
  const sp = request.nextUrl.searchParams;
  return handleCheckout(
    request,
    {
      product: sp.get("product") ?? "",
      buyer: parseBuyerQuery(sp),
      getAttr: (p) => sp.get(p),
    },
    302,
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const geoErr = buyerCountryError(request);
  if (geoErr) return geoErr;
  const parsed = await parsePostBody(request);
  if (!parsed.ok) return parsed.response;
  return handleCheckout(request, parsed.value, 303);
}

export async function HEAD(request: NextRequest): Promise<NextResponse> {
  const res = await GET(request);
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
