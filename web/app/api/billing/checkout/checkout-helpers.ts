import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_PAYMENT_PROVIDERS,
  GLOBAL,
  paymentProviderSetting,
  type PaymentProviderSetting,
} from "../../../../../payments/src/settings_registry";
import { applyCheckoutUrlTheme } from "../../../../../payments/src/checkout_branding";
import { attributionRef } from "../../../../src/lib/attribution";
import { buyerEmailsMatch, isValidBuyerEmail } from "../../../../src/lib/buyer-email";
import { isHouse } from "../../../../src/lib/house";
import type { PaddleOverlayPayload } from "../../../../src/lib/paddle-overlay";
import { buildPaddleOverlayPayload, paddleOverlayConfig, paddleOverlayUsable } from "../../../../src/lib/paddle-overlay-server";

export interface CheckoutRail {
  provider: string;
  weight: number;
  checkout_url: string;
}

export type ProductRow = {
  id: string;
  store_product_id?: string | null;
  creator_id: string | null;
  /** products.price_usd. Null means the product has no price and cannot be sold (checkout answers 409). */
  price_usd?: string | number | null;
  release_sha256?: string | null;
  checkout_mode?: string | null;
  /** The Paddle price the overlay sells (products.paddle_price_id). Null until the price is set up at Paddle. */
  paddle_price_id?: string | null;
  creators?: { handle?: string | null; is_house?: boolean | null } | Array<{ handle?: string | null; is_house?: boolean | null }> | null;
};

/**
 * True when the product's creator is the house (creators.is_house, operator-set).
 * A house title skips the creator consents C1-C3; its release file must still match the pin in house_release_pins.
 * PostgREST returns a many-to-one embed as an object, but the array form is accepted too. Any other shape is not house.
 */
export function isHouseProduct(product: ProductRow): boolean {
  const embedded = product.creators;
  const creator = Array.isArray(embedded) ? embedded[0] : embedded;
  return isHouse(creator?.is_house);
}

export interface BuyerFields {
  email?: string;
  consent?: boolean;
}

export interface ParsedCheckoutRequest {
  product: string;
  buyer: { ok: true; value: BuyerFields } | { ok: false; error: string; code: string };
  getAttr: (param: "src" | "dub_id") => string | null;
  /** The rail the buyer was shown (the merchant of record label), sent as `rail`. The route charges only this rail or answers 409. */
  expectedRail: string | null;
}

export function jsonError(status: number, error: string, code?: string): NextResponse {
  return NextResponse.json({ ok: false, error, code }, { status });
}

export function buyerCountryError(request: NextRequest): NextResponse | null {
  const ipCountry = request.headers.get("x-vercel-ip-country")?.trim().toUpperCase();
  if (!ipCountry || GLOBAL.payments.allowed_buyer_countries.includes(ipCountry)) return null;
  return jsonError(
    403,
    "At launch we sell only to buyers in the United States, its territories, and the District of Columbia.",
    "country_not_supported",
  );
}

export function creatorHandleOf(product: ProductRow, productRef: string): string | undefined {
  const rel = product.creators;
  const handle = Array.isArray(rel) ? rel[0]?.handle : rel?.handle;
  if (typeof handle === "string" && handle.trim() !== "") return handle.trim();
  if (productRef.includes("/")) {
    const fromRef = productRef.split("/")[0]?.trim();
    if (fromRef) return fromRef;
  }
  return undefined;
}

import { sandboxAllowed } from "../../../../src/lib/sandbox-checkout";

export { sandboxAllowed };

function providerCapabilities(provider: string): PaymentProviderSetting | undefined {
  const defaults = DEFAULT_PAYMENT_PROVIDERS as Record<string, PaymentProviderSetting>;
  return paymentProviderSetting(provider) ?? defaults[provider];
}

function withReference(checkoutUrl: string, provider: string, ref: string): string {
  const caps = providerCapabilities(provider);
  if (caps?.supports_reference_id === true) {
    const url = new URL(checkoutUrl);
    url.searchParams.set("reference_id", ref);
    return url.toString();
  }
  if (caps?.order_ref_param && ref) {
    const url = new URL(checkoutUrl);
    url.searchParams.set(caps.order_ref_param, ref);
    return url.toString();
  }
  return checkoutUrl;
}

/** Parses optional buyer email/consent for GET/HEAD. Absent is fine; a malformed value is a 400 (fail closed). */
export function parseBuyerQuery(sp: URLSearchParams): { ok: true; value: BuyerFields } | { ok: false; error: string; code: string } {
  const rawEmail = sp.get("buyer_email");
  const rawConsent = sp.get("buyer_consent");
  let email: string | undefined;
  if (rawEmail !== null) {
    if (!isValidBuyerEmail(rawEmail, GLOBAL.email_address.max_length)) {
      return { ok: false, error: "Invalid buyer email", code: "buyer_email_invalid" };
    }
    email = rawEmail.trim();
  }
  let consent: boolean | undefined;
  if (rawConsent !== null) {
    if (rawConsent !== "true" && rawConsent !== "false") {
      return { ok: false, error: "Invalid buyer consent", code: "buyer_consent_invalid" };
    }
    consent = rawConsent === "true";
  }
  return { ok: true, value: { email, consent } };
}

/** Parses and enforces buyer email + confirm match + consent for POST submissions. */
export function parseBuyerPost(
  getRaw: (key: string) => string | boolean | null,
): { ok: true; value: BuyerFields } | { ok: false; error: string; code: string } {
  const rawEmail = getRaw("buyer_email");
  if (typeof rawEmail !== "string" || !isValidBuyerEmail(rawEmail, GLOBAL.email_address.max_length)) {
    return { ok: false, error: "Invalid buyer email", code: "buyer_email_invalid" };
  }
  const rawConfirm = getRaw("buyer_email_confirm");
  if (typeof rawConfirm !== "string" || !buyerEmailsMatch(rawEmail, rawConfirm)) {
    return { ok: false, error: "Buyer email addresses do not match", code: "buyer_email_mismatch" };
  }
  const rawConsent = getRaw("buyer_consent");
  let consent = false;
  if (rawConsent !== null) {
    if (typeof rawConsent === "boolean") {
      consent = rawConsent;
    } else if (rawConsent === "true" || rawConsent === "false") {
      consent = rawConsent === "true";
    } else {
      return { ok: false, error: "Invalid buyer consent", code: "buyer_consent_invalid" };
    }
  }
  return { ok: true, value: { email: rawEmail.trim(), consent } };
}

/**
 * Buyer email, consent, product_id, and success_url on the provider's checkout link, only where documented.
 * Paddle's hosted checkout documents user_email (prefills the buyer's email; the buyer can still edit it). It documents no
 * consent parameter and no success_url on the link, so neither is set there.
 */
export function buildCheckoutRedirectUrl(
  rail: CheckoutRail,
  product: ProductRow,
  creatorHandle: string | undefined,
  attribution: string,
  buyer: BuyerFields,
): string {
  const target = withReference(rail.checkout_url, rail.provider, attribution);
  const caps = providerCapabilities(rail.provider);
  const params: Array<[string, string]> = [];
  if (caps?.buyer_email_param && buyer.email !== undefined) {
    params.push([caps.buyer_email_param, buyer.email]);
  }
  if (caps?.supports_consent_metadata === true && buyer.consent !== undefined) {
    params.push([`metadata[${GLOBAL.delivery.buyer_consent_metadata_key}]`, String(buyer.consent)]);
  }
  if (caps?.metadata_product_id_param) {
    const providerProductId =
      typeof product.store_product_id === "string" && product.store_product_id.trim() !== ""
        ? product.store_product_id.trim()
        : product.id;
    params.push([caps.metadata_product_id_param, providerProductId]);
  }
  const wantsSuccessUrl = Boolean(caps?.success_url_param && creatorHandle);
  const wantsTheme = Boolean(caps?.theme_param);
  if (params.length === 0 && !wantsSuccessUrl && !wantsTheme) return target;

  const url = new URL(target);
  for (const [key, value] of params) url.searchParams.set(key, value);
  if (caps?.success_url_param && creatorHandle && !url.searchParams.has(caps.success_url_param)) {
    const origin = GLOBAL.delivery.download_origin.replace(/\/$/, "");
    const thanks = GLOBAL.storefront.thanks_path_template.replace("{handle}", encodeURIComponent(creatorHandle));
    url.searchParams.set(caps.success_url_param, `${origin}${thanks}`);
  }
  applyCheckoutUrlTheme(url, caps?.theme_param, GLOBAL.branding);
  return url.toString();
}

/** True when a POST caller explicitly asks for a JSON overlay/redirect descriptor rather than a 303 HTTP redirect. */
export function wantsCheckoutOverlayJson(request: NextRequest): boolean {
  const accept = request.headers.get("accept")?.toLowerCase() ?? "";
  return accept.includes("application/json");
}

/**
 * Builds the Paddle.js overlay payload when the selected rail is Paddle, the product has a Paddle price id,
 * the creator handle is known, and the server's Paddle overlay config matches the product's checkout_mode.
 * Returns null otherwise so callers fall back to the provider's redirect URL.
 */
export function resolvePaddleOverlay(
  rail: CheckoutRail,
  product: ProductRow,
  creatorHandle: string | undefined,
  attribution: string,
  buyer: BuyerFields,
): PaddleOverlayPayload | null {
  if (rail.provider !== "paddle") return null;
  const priceId = typeof product.paddle_price_id === "string" ? product.paddle_price_id.trim() : "";
  if (!priceId || !creatorHandle) return null;
  const cfg = paddleOverlayConfig();
  if (!cfg.ok || !paddleOverlayUsable(cfg.client, product.checkout_mode)) return null;
  return buildPaddleOverlayPayload({
    priceId,
    creatorHandle,
    orderRef: attribution,
    buyerEmail: buyer.email,
    buyerConsent: buyer.consent === true,
  });
}

export function checkoutUrlProblem(raw: unknown, expectedMode?: string | null): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return "missing";
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch (err) {
    console.warn("[billing/checkout] malformed rail checkout_url:", err instanceof Error ? err.message : String(err));
    return "malformed";
  }
  if (url.protocol !== "https:") return "not https";
  const labels = url.hostname.toLowerCase().split(/[.-]/);
  const pathSegments = url.pathname.toLowerCase().split("/").filter(Boolean);
  const isSandboxUrl =
    labels.includes("sandbox") ||
    labels.includes("test") ||
    labels.includes("stage") ||
    pathSegments[0] === "test";
  if (isSandboxUrl && !sandboxAllowed()) return "sandbox host not allowed";
  if (expectedMode === "live" && isSandboxUrl) return "sandbox rail on live product";
  if (expectedMode === "sandbox" && !isSandboxUrl) return "live rail on sandbox product";
  return null;
}

export async function parsePostBody(
  request: NextRequest,
): Promise<{ ok: true; value: ParsedCheckoutRequest } | { ok: false; response: NextResponse }> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const qp = request.nextUrl.searchParams;

  if (contentType.includes("application/json")) {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch (err) {
      console.warn("[billing/checkout] invalid JSON POST body:", err instanceof Error ? err.message : String(err));
      return { ok: false, response: jsonError(400, "Invalid request body") };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, response: jsonError(400, "Invalid request body") };
    }
    const obj = raw as Record<string, unknown>;
    const getRaw = (key: string): string | boolean | null => {
      const v = obj[key];
      if (typeof v === "string" || typeof v === "boolean") return v;
      return null;
    };
    const productVal = obj.product;
    const product = typeof productVal === "string" ? productVal : (qp.get("product") ?? "");
    const railVal = obj.rail;
    // The label is a string or null. Anything else would read as "no label" and skip the rail_changed pin, so refuse it.
    if (railVal !== undefined && railVal !== null && typeof railVal !== "string") {
      return { ok: false, response: jsonError(400, "Invalid rail", "rail_invalid") };
    }
    return {
      ok: true,
      value: {
        product,
        expectedRail: typeof railVal === "string" && railVal.trim() !== "" ? railVal.trim() : null,
        buyer: parseBuyerPost(getRaw),
        getAttr: (param) => {
          const v = obj[param];
          return typeof v === "string" && v !== "" ? v : qp.get(param);
        },
      },
    };
  }

  let formMap: { get: (fieldName: string) => FormDataEntryValue | string | null };
  if (contentType.includes("multipart/form-data")) {
    try {
      formMap = await request.formData();
    } catch (err) {
      console.warn("[billing/checkout] invalid multipart POST body:", err instanceof Error ? err.message : String(err));
      return { ok: false, response: jsonError(400, "Invalid request body") };
    }
  } else {
    let text = "";
    try {
      text = await request.text();
    } catch (err) {
      console.warn("[billing/checkout] unreadable POST body:", err instanceof Error ? err.message : String(err));
      return { ok: false, response: jsonError(400, "Invalid request body") };
    }
    formMap = new URLSearchParams(text);
  }

  const getField = (key: string): string | null => {
    const v = formMap.get(key);
    return typeof v === "string" ? v : null;
  };
  // Same contract as the JSON path: a multipart file part under `rail` is not a label. getField would read it as null
  // and skip the rail_changed pin, so refuse it. (A urlencoded body is always strings, so this only fires for multipart.)
  const rawRail = formMap.get("rail");
  if (rawRail !== null && rawRail !== undefined && typeof rawRail !== "string") {
    return { ok: false, response: jsonError(400, "Invalid rail", "rail_invalid") };
  }
  const product = getField("product") ?? qp.get("product") ?? "";
  const railField = getField("rail")?.trim() ?? "";
  return {
    ok: true,
    value: {
      product,
      expectedRail: railField !== "" ? railField : null,
      buyer: parseBuyerPost(getField),
      getAttr: (param) => getField(param) ?? qp.get(param),
    },
  };
}

export function buildAttributionRef(getAttr: (param: "src" | "dub_id") => string | null): string {
  return attributionRef(getAttr);
}
