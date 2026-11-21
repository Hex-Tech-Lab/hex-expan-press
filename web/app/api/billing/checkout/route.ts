import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { MatrixRouter } from "../../../../../src/infrastructure/matrix_router/matrix_router";
import { getSupabaseAdmin } from "../../../../../payments/src/supabase_admin";
import { GLOBAL, isEnabledPaymentProvider } from "../../../../../payments/src/settings_registry";
import { productPriceUsd } from "../../../../src/lib/product-purchasable";
import { resolveCheckoutRails } from "../../../../src/lib/checkout-rails";
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
  isHouseProduct,
  jsonError,
  parseBuyerQuery,
  parsePostBody,
  resolvePaddleOverlay,
  sandboxAllowed,
  wantsCheckoutOverlayJson,
  type CheckoutRail,
  type ParsedCheckoutRequest,
  type ProductRow,
} from "./checkout-helpers";

export const runtime = "nodejs";

type SupabaseAdmin = NonNullable<Awaited<ReturnType<typeof getSupabaseAdmin>>>;
type ProductLookup = { product: ProductRow } | { response: NextResponse };

const PRODUCT_COLUMNS = "id, store_product_id, creator_id, release_sha256, checkout_mode, paddle_price_id, price_usd";
const GATE_CONSENT_KINDS = ["C1_data_accuracy", "C2_release_approval", "C3_revenue_split"] as const;
const CONSENT_VERIFICATION_FAILED = "Checkout consent verification failed";

function lookupFailed(product: string, message: string): ProductLookup {
  console.warn(`[billing/checkout] product lookup warning for '${product}': ${message}`);
  // A failed product lookup on a revenue path is an incident: report it.
  Sentry.captureException(new Error(`checkout: product lookup failed: ${message}`), { tags: { surface: "checkout_route", reason: "product_lookup_failed" } });
  return { response: jsonError(500, CONSENT_VERIFICATION_FAILED) };
}

/** 503 Service Unavailable with a Retry-After header (seconds come from the registry). Callers fail closed before any order or provider label is written. */
function retryAfterUnavailable(error: string, code: string, retryAfterSeconds: number): NextResponse {
  const res = jsonError(503, error, code);
  res.headers.set("Retry-After", String(retryAfterSeconds));
  return res;
}

/** No active payment rail, so the buyer is never sent to a default provider. */
function noActiveRailResponse(): NextResponse {
  return retryAfterUnavailable(
    "Checkout is temporarily unavailable. No payment rail is accepting orders.",
    "no_active_rail",
    GLOBAL.payments.checkout_no_rail_retry_after_seconds,
  );
}

function productNotFound(product: string): ProductLookup {
  console.error(`[billing/checkout] product '${product}' not found — failing closed`);
  return { response: jsonError(404, "Product not found", "product_not_found") };
}

async function lookupProduct(supabase: SupabaseAdmin, product: string): Promise<ProductLookup> {
  if (guidSchema.safeParse(product).success) {
    const { data, error } = await supabase
      .from("products")
      .select(`${PRODUCT_COLUMNS}, creators(handle, is_house)`)
      .eq("id", product)
      .maybeSingle();
    if (error) return lookupFailed(product, error.message);
    return data ? { product: data as ProductRow } : productNotFound(product);
  }

  if (product.includes("/")) {
    const [handle, slug] = product.split("/");
    const { data, error } = await supabase
      .from("products")
      .select(`${PRODUCT_COLUMNS}, creators!inner(handle, is_house)`)
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

/**
 * Creator gate. C1, C2 and C3 must each have exactly one active head, and the C2 head must approve the product's release hash.
 * Returns the refusal, or null when checkout may continue. Errors inside propagate to handleCheckout's fail-closed catch.
 */
async function checkCreatorConsents(
  supabase: SupabaseAdmin,
  product: string,
  resolvedProduct: ProductRow,
  ownerId: string,
): Promise<NextResponse | null> {
  const { data: consentRows, error: consentErr, count: consentCount } = await supabase
    .from("consents")
    .select("id, kind, decision, product_id, supersedes, supersedes_ids, document_sha256", { count: "exact" })
    .eq("creator_id", ownerId)
    .in("kind", GATE_CONSENT_KINDS);

  if (consentErr) {
    console.error(`[billing/checkout] failed to query consents for '${product}': ${consentErr.message}`);
    // A 500 on a revenue path is an incident: report it so it shows in Sentry, not only in the console.
    Sentry.captureException(new Error(`checkout: consents query failed: ${consentErr.message}`), { tags: { surface: "checkout_route", reason: "consents_query_failed" } });
    return jsonError(500, CONSENT_VERIFICATION_FAILED);
  }
  if (typeof consentCount !== "number" || consentCount !== (consentRows ?? []).length) {
    console.error(`[billing/checkout] incomplete consent history for '${product}': got ${(consentRows ?? []).length} of ${consentCount ?? "unknown"}`);
    // A consent-count mismatch is a data-integrity signal on a revenue path: report it.
    Sentry.captureException(new Error(`checkout: incomplete consent history for '${product}'`), { tags: { surface: "checkout_route", reason: "consent_history_incomplete" } });
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
  return null;
}

/**
 * House gate (founder decision, 2026-11-19). A house title has no creator consents to check. Its release file must still match
 * the digest the operator pinned in house_release_pins (the sha256 of the stored object). Returns the refusal, or null.
 */
async function checkHousePin(supabase: SupabaseAdmin, product: string, resolvedProduct: ProductRow): Promise<NextResponse | null> {
  const releaseSha = normalizeSha256(resolvedProduct.release_sha256);
  const { data: pinRow, error: pinErr } = await supabase
    .from("house_release_pins")
    .select("sha256")
    .eq("product_id", resolvedProduct.id)
    .maybeSingle();
  if (pinErr) {
    console.error(`[billing/checkout] failed to read the house release pin for '${product}': ${pinErr.message}`);
    // A failed house-pin read is a database outage on a revenue path: report it.
    Sentry.captureException(new Error(`checkout: house pin read failed: ${pinErr.message}`), { tags: { surface: "checkout_route", reason: "house_pin_read_failed" } });
    return jsonError(500, CONSENT_VERIFICATION_FAILED);
  }
  const pinnedSha = normalizeSha256((pinRow as { sha256?: unknown } | null)?.sha256);
  if (!releaseSha || !pinnedSha || pinnedSha !== releaseSha) {
    console.error(`[billing/checkout] house release hash mismatch for '${product}': release=${releaseSha ?? "invalid"} pinned=${pinnedSha ?? "none"}`);
    return jsonError(403, "Checkout forbidden: release hash mismatch");
  }
  return null;
}

async function handleCheckout(
  request: NextRequest,
  parsed: ParsedCheckoutRequest,
  redirectStatus: 302 | 303,
): Promise<NextResponse> {
  const geoErr = buyerCountryError(request);
  if (geoErr) return geoErr;

  const { product, buyer, getAttr, expectedRail } = parsed;
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
      // A missing service-role client on the revenue path is a deploy misconfiguration: report it.
      Sentry.captureException(new Error("checkout: admin client unavailable"), { tags: { surface: "checkout_route", reason: "admin_client_unavailable" } });
      return jsonError(500, CONSENT_VERIFICATION_FAILED);
    }

    const lookup = await lookupProduct(supabase, product);
    if ("response" in lookup) return lookup.response;
    resolvedProduct = lookup.product;

    const mode = resolvedProduct.checkout_mode;
    if (mode !== "live" && !(mode === "sandbox" && sandboxAllowed())) {
      console.error(`[billing/checkout] product '${product}' is not launched (checkout_mode=${mode ?? "null"})`);
      return jsonError(403, "Checkout forbidden: product is not launched");
    }

    // Fail closed on a null price before any consent or rail work: an unpriced product is not for sale (409 Conflict).
    if (productPriceUsd(resolvedProduct.price_usd) === null) {
      console.error(`[billing/checkout] product '${product}' has no usable price (null, blank or non-numeric) — refusing checkout`);
      return jsonError(409, "Product has no price and is not available for purchase", "product_unpriced");
    }

    const ownerId = resolvedProduct.creator_id;
    if (!ownerId) {
      console.error(`[billing/checkout] product owner unresolvable for '${product}' — failing closed`);
      // A product with no owner is a data-integrity fault on a revenue path: report it.
      Sentry.captureException(new Error("checkout: product owner unresolvable"), { tags: { surface: "checkout_route", reason: "owner_unresolvable" } });
      return jsonError(500, CONSENT_VERIFICATION_FAILED);
    }

    const refusal = isHouseProduct(resolvedProduct)
      ? await checkHousePin(supabase, product, resolvedProduct)
      : await checkCreatorConsents(supabase, product, resolvedProduct, ownerId);
    if (refusal) return refusal;

    const { data: railRows, error: railErr } = await supabase
      .from("product_rails")
      .select("provider, weight, checkout_url, active")
      .eq("product_id", resolvedProduct.id)
      .order("weight", { ascending: false });
    if (railErr) {
      console.error(`[billing/checkout] rails query failed for '${product}': ${railErr.message}`);
      // A rails-table outage on a paid product is an incident: report it.
      Sentry.captureException(new Error(`checkout: rails query failed: ${railErr.message}`), { tags: { surface: "checkout_route", reason: "rails_query_failed" } });
      return jsonError(500, CONSENT_VERIFICATION_FAILED);
    }
    // Shared resolver (web/src/lib/checkout-rails.ts): the same verified-provider filter the checkout page counts with.
    const resolution = resolveCheckoutRails(railRows, {
      isEnabledProvider: isEnabledPaymentProvider,
      verifiedProviders: verifiedProviderNames(),
      checkoutMode: resolvedProduct.checkout_mode,
      checkoutUrlProblem: checkoutUrlProblem,
    });
    if (resolution.kind === "malformed") {
      const detail =
        resolution.reason === "non_object_row"
          ? "has a malformed product_rails row"
          : resolution.reason === "invalid_checkout_url"
            ? "has a usable rail with an invalid checkout_url"
            : resolution.reason === "invalid_weight"
              ? "has an active rail with a weight that is not greater than 0"
              : "has an active rail with a missing provider or non-string checkout_url";
      console.error(`[billing/checkout] product '${product}' ${detail} — failing closed`);
      // A 500 is an incident on a revenue path: report it, like the other failure branches of this handler.
      Sentry.captureException(new Error(`checkout: malformed product_rails (${resolution.reason})`), { tags: { surface: "checkout_route", reason: resolution.reason } });
      return jsonError(500, "Checkout is not configured");
    }
    dbRails = resolution.usable;
    const activeRailCount = resolution.activeCount;

    if (dbRails.length === 0) {
      console.error(`[billing/checkout] product '${product}' has ${activeRailCount} active enabled rail(s) and none usable — refusing checkout`);
      // Report only when an active, enabled rail exists and none is usable. A switched-off rail and a product with no rail
      // are designed states and are not reported.
      if (activeRailCount > 0) {
        Sentry.captureException(new Error("checkout: active enabled rails, none usable"), { tags: { surface: "checkout_route", reason: "no_active_rail" } });
      }
      return noActiveRailResponse();
    }
  } catch (err) {
    // A thrown value need not be an Error (a thrown null would make (err as Error).message throw here and skip the report).
    console.error(`[billing/checkout] consent verification exception for '${product}': ${err instanceof Error ? err.message : String(err)}`);
    // A 500 here is an incident, so it is reported under the checkout_gate_unexpected tag.
    Sentry.captureException(err, { tags: { surface: "checkout_route", reason: "checkout_gate_unexpected" } });
    return jsonError(500, CONSENT_VERIFICATION_FAILED);
  }

  if (dbRails.length === 0) {
    console.error(`[billing/checkout] product '${product}' has no active payment rail — answering 503, no order and no provider label`);
    return noActiveRailResponse();
  }
  const rails: CheckoutRail[] = dbRails;

  for (const rail of rails) {
    rail.checkout_url = rail.checkout_url.trim();
    const problem = checkoutUrlProblem(rail.checkout_url, resolvedProduct.checkout_mode);
    if (problem) {
      console.error(`[billing/checkout] rejected checkout_url for '${product}' (${rail.provider}): ${problem}`);
      // A configured rail with an unusable checkout URL is a misconfiguration on a revenue path: report it.
      Sentry.captureException(new Error(`checkout: rejected checkout_url (${problem})`), { tags: { surface: "checkout_route", reason: "checkout_url_rejected" } });
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
      // The router named a rail that is not among the usable rails (or it has no checkout URL). Fail closed with a
      // retryable 503 and the registry Retry-After, and never send the buyer to another provider.
      console.error(`[billing/checkout] selected rail '${providerName}' is missing or has no checkout_url — answering 503 rail_misconfigured`);
      Sentry.captureException(new Error(`checkout: selected rail missing or has no checkout_url (${providerName})`), { tags: { surface: "checkout_route", reason: "rail_misconfigured" } });
      return retryAfterUnavailable(
        "Checkout is temporarily unavailable. Please try again shortly.",
        "rail_misconfigured",
        GLOBAL.payments.checkout_no_rail_retry_after_seconds,
      );
    }
  } catch (err) {
    // Only the known router outage (every rail marked down by the breaker) is a 503. Anything else is a bug or an
    // unexpected failure: log it with its stack and answer 500. Never fall back to the highest-weight rail.
    if (err instanceof MatrixRouterUnavailableError) {
      console.error(`[billing/checkout] every rail is marked down for '${product}' — answering 503`);
      return retryAfterUnavailable(
        "Checkout is temporarily unavailable. No payment rail is accepting orders.",
        "rails_unavailable",
        GLOBAL.payments.checkout_router_error_retry_after_seconds,
      );
    }
    // A rejection can be any value (including null or undefined), so read .stack only from a real Error.
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[billing/checkout] MatrixRouter unexpected failure for '${product}': ${detail} — answering 500, no default provider`);
    Sentry.captureException(err, { tags: { surface: "checkout_route", reason: "router_unexpected_error" } });
    return jsonError(500, "Checkout failed unexpectedly", "router_unexpected_error");
  }

  // The label the buyer saw must be the rail that is charged. A rail set that changed since the page rendered (a rail added,
  // switched off, or re-weighted) makes the router pick another provider: refuse before any order or provider label.
  if (expectedRail && selectedRail.provider !== expectedRail) {
    // The label is buyer-supplied: JSON-encode it (escapes CR/LF and control characters), escape the line separators U+2028 and
    // U+2029 (JSON leaves them raw), then cut the ENCODED text, so the logged length never exceeds rail_label_log_max_chars.
    const shownRail = JSON.stringify(expectedRail)
      .replace(/[\u2028\u2029]/g, (char) => (char === "\u2028" ? "\\u2028" : "\\u2029"))
      .slice(0, GLOBAL.payments.rail_label_log_max_chars);
    console.error(`[billing/checkout] rail changed for '${product}': page showed ${shownRail}, router selected '${selectedRail.provider}' — answering 409 rail_changed`);
    return jsonError(409, "The payment provider for this product has changed. Reload the page and try again.", "rail_changed");
  }

  const redirectUrl = buildCheckoutRedirectUrl(selectedRail, resolvedProduct, creatorHandle, attribution, buyer.value);
  if (redirectStatus === 303 && wantsCheckoutOverlayJson(request)) {
    const overlayPayload = resolvePaddleOverlay(selectedRail, resolvedProduct, creatorHandle, attribution, buyer.value);
    const body = overlayPayload
      ? { ok: true, kind: "paddle_overlay" as const, payload: overlayPayload }
      : { ok: true, kind: "redirect" as const, redirectUrl };
    const res = NextResponse.json(body, { status: 200 });
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
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
      expectedRail: sp.get("rail")?.trim() || null,
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
