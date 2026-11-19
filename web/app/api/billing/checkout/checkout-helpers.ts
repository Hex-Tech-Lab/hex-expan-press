import { NextRequest, NextResponse } from "next/server";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import { attributionRef } from "../../../../src/lib/attribution";
import { buyerEmailsMatch, isValidBuyerEmail } from "../../../../src/lib/buyer-email";

export interface CheckoutRail {
  provider: string;
  weight: number;
  checkout_url: string;
}

export type ProductRow = {
  id: string;
  store_product_id?: string | null;
  creator_id: string | null;
  release_sha256?: string | null;
  checkout_mode?: string | null;
  creators?: { handle?: string | null } | Array<{ handle?: string | null }> | null;
};

export interface BuyerFields {
  email?: string;
  consent?: boolean;
}

export interface ParsedCheckoutRequest {
  product: string;
  buyer: { ok: true; value: BuyerFields } | { ok: false; error: string; code: string };
  getAttr: (param: "src" | "dub_id") => string | null;
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

function isNonProductionRuntime(): boolean {
  const v = process.env.VERCEL_ENV;
  if (v === "preview" || v === "development") return true;
  if (v) return false;
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

export function sandboxAllowed(): boolean {
  if (!isNonProductionRuntime()) return false;
  return GLOBAL.payments?.sandbox_checkout_enabled === true;
}

const REFERENCE_ID_PROVIDERS = new Set(["polar"]);

function withReference(checkoutUrl: string, provider: string, ref: string): string {
  if (REFERENCE_ID_PROVIDERS.has(provider)) {
    const url = new URL(checkoutUrl);
    url.searchParams.set("reference_id", ref);
    return url.toString();
  }
  if (provider === "creem" && ref) {
    const url = new URL(checkoutUrl);
    url.searchParams.set("metadata[order_ref]", ref);
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
 * Paddle's redirect link documents none, so its URL stays untouched.
 */
export function buildCheckoutRedirectUrl(
  rail: CheckoutRail,
  product: ProductRow,
  creatorHandle: string | undefined,
  attribution: string,
  buyer: BuyerFields,
): string {
  const target = withReference(rail.checkout_url, rail.provider, attribution);
  const params: Array<[string, string]> = [];
  if (rail.provider === "polar" && buyer.email !== undefined) {
    params.push(["customer_email", buyer.email]);
  }
  if (rail.provider === "creem") {
    if (buyer.consent !== undefined) {
      params.push([`metadata[${GLOBAL.delivery.buyer_consent_metadata_key}]`, String(buyer.consent)]);
    }
    const creemProductId =
      typeof product.store_product_id === "string" && product.store_product_id.trim() !== ""
        ? product.store_product_id.trim()
        : product.id;
    params.push(["metadata[product_id]", creemProductId]);
  }
  if (params.length === 0 && !(rail.provider === "creem" && creatorHandle)) return target;

  const url = new URL(target);
  for (const [key, value] of params) url.searchParams.set(key, value);
  if (rail.provider === "creem" && creatorHandle && !url.searchParams.has("success_url")) {
    const origin = GLOBAL.delivery.download_origin.replace(/\/$/, "");
    url.searchParams.set("success_url", `${origin}/books/${creatorHandle}/thanks`);
  }
  return url.toString();
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
    return {
      ok: true,
      value: {
        product,
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
  const product = getField("product") ?? qp.get("product") ?? "";
  return {
    ok: true,
    value: {
      product,
      buyer: parseBuyerPost(getField),
      getAttr: (param) => getField(param) ?? qp.get(param),
    },
  };
}

export function buildAttributionRef(getAttr: (param: "src" | "dub_id") => string | null): string {
  return attributionRef(getAttr);
}
