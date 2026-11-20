/**
 * Create (or verify existing) sample book product and one-time price in Paddle SANDBOX ONLY.
 *
 * Reads title, subtitle, slug, store_product_id, and price from the book identity SSOT
 * (books/sample_the_quiet_workshop.json) and reads the sandbox base URL, API key env name,
 * tax_category, default currency, and HTTP timeout from payments/src/settings_registry.ts.
 *
 * Fail closed: refuses any live API key (pdl_live_* or non-pdl_sdbx_*), any non-sandbox base URL,
 * or any production runtime flag. Never loads .env directly and never prints secret values.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBookIdentity, type BookIdentity } from "../payments/book_identity.ts";
import { GLOBAL } from "../payments/src/settings_registry.ts";
import { usdToCents } from "../payments/src/split.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BOOK_REF = "books/sample_the_quiet_workshop.json";
const SANDBOX_HOST = "sandbox-api.paddle.com";

const HTTP_MEANINGS: Record<number, string> = {
  200: "200 OK",
  201: "201 Created",
  400: "400 Bad Request",
  401: "401 Unauthorized",
  403: "403 Forbidden",
  404: "404 Not Found",
  409: "409 Conflict",
  422: "422 Unprocessable Entity",
  429: "429 Too Many Requests",
  500: "500 Internal Server Error",
  502: "502 Bad Gateway",
  503: "503 Service Unavailable",
};

export function describeHttpStatus(status: number): string {
  return HTTP_MEANINGS[status] ?? `${status} HTTP Error`;
}

export interface PaddleProductCreateBody {
  name: string;
  description: string;
  tax_category: string;
  custom_data: {
    store_product_id: string;
    product_slug: string;
  };
}

export interface PaddlePriceCreateBody {
  description: string;
  product_id: string;
  name: string;
  unit_price: {
    amount: string;
    currency_code: string;
  };
  billing_cycle: null;
  tax_mode: "account_setting";
  custom_data: {
    store_product_id: string;
    product_slug: string;
  };
}

export interface SandboxProvisionResult {
  dryRun: boolean;
  apiBase: string;
  taxCategory: string;
  requestedTaxCategory: string;
  rejectedTaxCategories?: Array<{ taxCategory: string; status: string; code: string }>;
  storeProductId: string;
  productSlug: string;
  productCreated: boolean;
  priceCreated: boolean;
  productId: string | null;
  priceId: string | null;
  productPayload: PaddleProductCreateBody;
  pricePayloadTemplate: Omit<PaddlePriceCreateBody, "product_id">;
  verifiedStatus?: { product: string; price: string };
}

export function resolveBookPath(bookArg: string = DEFAULT_BOOK_REF): string {
  const normalized = bookArg.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const withDir = normalized.includes("/") ? normalized : `books/${normalized}`;
  const withExt = withDir.endsWith(".json") ? withDir : `${withDir}.json`;
  if (!withExt.startsWith("books/") || withExt.split("/").includes("..")) {
    throw new Error(`paddle_sandbox_sample_product: book reference "${bookArg}" must live under books/`);
  }
  return path.resolve(here, "..", withExt);
}

/** Hard sandbox-only gate: refuses any live key, live/non-sandbox URL, or production environment flag. */
export function assertSandboxOnly(
  apiBase: string,
  apiKey: string | undefined,
  env: Record<string, string | undefined>,
  options: { allowMissingKey?: boolean } = {},
): string {
  if (env.PADDLE_ENVIRONMENT === "production" || env.VERCEL_ENV === "production" || env.NODE_ENV === "production") {
    throw new Error("Refusing to run: production environment flag is active (sandbox only)");
  }

  let parsed: URL;
  try {
    parsed = new URL(apiBase);
  } catch {
    throw new Error(`Refusing invalid Paddle API base URL: ${apiBase}`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== SANDBOX_HOST || parsed.username !== "" || parsed.password !== "") {
    throw new Error(`Refusing non-sandbox Paddle base URL "${apiBase}" (must be https://${SANDBOX_HOST})`);
  }

  const trimmed = (apiKey ?? "").trim();
  if (trimmed === "") {
    if (options.allowMissingKey) return "";
    throw new Error(`Missing sandbox API key env var ${GLOBAL.payments.paddle.sandbox_api_key_env}`);
  }
  if (trimmed.startsWith("pdl_live_")) {
    throw new Error("Refusing live Paddle API key (pdl_live_* is forbidden in sandbox script)");
  }
  if (!trimmed.startsWith("pdl_sdbx_")) {
    throw new Error("Refusing unrecognized Paddle API key (sandbox key must start with pdl_sdbx_)");
  }
  return trimmed;
}

export function buildSamplePayloads(identity: BookIdentity): {
  storeProductId: string;
  productSlug: string;
  taxCategory: string;
  productPayload: PaddleProductCreateBody;
  pricePayloadTemplate: Omit<PaddlePriceCreateBody, "product_id">;
  minorAmount: string;
  currency: string;
} {
  const productSlug = identity.product_slug ?? identity.id;
  const storeProductId = identity.store_product_id;
  if (!storeProductId) {
    throw new Error(`Book registry "${identity.id}" must define store_product_id`);
  }
  if (!identity.price) {
    throw new Error(`Book registry "${identity.id}" must define price.usd and price.currency`);
  }
  const currency = (identity.price.currency || GLOBAL.defaults.currency).toUpperCase();
  const minorAmount = String(usdToCents(identity.price.usd));
  const taxCategory = GLOBAL.payments.paddle.product_tax_category;

  const productPayload: PaddleProductCreateBody = {
    name: identity.title,
    description: identity.subtitle,
    tax_category: taxCategory,
    custom_data: {
      store_product_id: storeProductId,
      product_slug: productSlug,
    },
  };

  const priceDescription = `${identity.description ?? identity.subtitle}, one-time ${currency} ${identity.price.usd.toFixed(2)}`;
  const pricePayloadTemplate: Omit<PaddlePriceCreateBody, "product_id"> = {
    description: priceDescription,
    name: `${identity.title}, ${currency} ${identity.price.usd.toFixed(2)}`,
    unit_price: {
      amount: minorAmount,
      currency_code: currency,
    },
    billing_cycle: null,
    tax_mode: "account_setting",
    custom_data: {
      store_product_id: storeProductId,
      product_slug: productSlug,
    },
  };

  return {
    storeProductId,
    productSlug,
    taxCategory,
    productPayload,
    pricePayloadTemplate,
    minorAmount,
    currency,
  };
}

interface PaddleProductRecord {
  id: string;
  name?: string;
  description?: string | null;
  tax_category?: string;
  custom_data?: Record<string, unknown> | null;
}

interface PaddlePriceRecord {
  id: string;
  product_id?: string;
  name?: string | null;
  unit_price?: { amount?: string; currency_code?: string } | null;
  billing_cycle?: unknown;
  custom_data?: Record<string, unknown> | null;
}

async function paddleJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  expectedStatus: number,
): Promise<{ statusText: string; data: T }> {
  const res = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(GLOBAL.payments.sync_http_timeout_ms),
  });
  const statusText = describeHttpStatus(res.status);
  if (res.status !== expectedStatus) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Paddle ${init.method ?? "GET"} ${new URL(url).pathname} returned ${statusText}: ${errText.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: T };
  if (!json || json.data === undefined) {
    throw new Error(`Paddle ${init.method ?? "GET"} ${new URL(url).pathname} returned ${statusText} with missing data field`);
  }
  return { statusText, data: json.data };
}

export async function provisionSandboxSampleProduct(options: {
  bookFile?: string;
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
} = {}): Promise<SandboxProvisionResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const dryRun = options.dryRun === true;
  const apiBase = GLOBAL.payments.paddle.api_base.sandbox.replace(/\/+$/, "");
  const keyEnvName = GLOBAL.payments.paddle.sandbox_api_key_env;
  const apiKey = assertSandboxOnly(apiBase, env[keyEnvName], env, { allowMissingKey: dryRun });

  const identity = loadBookIdentity(options.bookFile ?? resolveBookPath(DEFAULT_BOOK_REF));
  const built = buildSamplePayloads(identity);

  if (dryRun) {
    return {
      dryRun: true,
      apiBase,
      taxCategory: built.taxCategory,
      requestedTaxCategory: built.taxCategory,
      storeProductId: built.storeProductId,
      productSlug: built.productSlug,
      productCreated: false,
      priceCreated: false,
      productId: null,
      priceId: null,
      productPayload: built.productPayload,
      pricePayloadTemplate: built.pricePayloadTemplate,
    };
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  // Check existing active sandbox products first so repeated runs remain idempotent.
  const listedProducts = await paddleJson<PaddleProductRecord[]>(
    fetchImpl,
    `${apiBase}/products?status=active&per_page=100`,
    { method: "GET", headers },
    200,
  );
  let product = listedProducts.data.find(
    (p) =>
      p.custom_data?.store_product_id === built.storeProductId ||
      p.name === built.productPayload.name,
  );
  let productCreated = false;
  let actualTaxCategory = product?.tax_category ?? built.taxCategory;
  let actualProductPayload = built.productPayload;
  const rejectedTaxCategories: Array<{ taxCategory: string; status: string; code: string }> = [];
  if (!product) {
    const candidates = [
      built.taxCategory,
      ...GLOBAL.payments.paddle.sandbox_tax_category_fallbacks.filter((c) => c !== built.taxCategory),
    ];
    for (const candidate of candidates) {
      const candidatePayload: PaddleProductCreateBody = {
        ...built.productPayload,
        tax_category: candidate,
      };
      const res = await fetchImpl(`${apiBase}/products`, {
        method: "POST",
        headers,
        body: JSON.stringify(candidatePayload),
        signal: AbortSignal.timeout(GLOBAL.payments.sync_http_timeout_ms),
      });
      const statusText = describeHttpStatus(res.status);
      if (res.status === 201) {
        const json = (await res.json()) as { data?: PaddleProductRecord };
        if (!json?.data) {
          throw new Error(`Paddle POST /products returned ${statusText} with missing data field`);
        }
        product = json.data;
        productCreated = true;
        actualTaxCategory = candidate;
        actualProductPayload = candidatePayload;
        break;
      }
      const rawErr = await res.text().catch(() => "");
      let errCode = "";
      try {
        errCode = ((JSON.parse(rawErr) as { error?: { code?: string } }).error?.code) ?? "";
      } catch {
        errCode = "";
      }
      if (res.status === 400 && errCode === "product_tax_category_not_approved") {
        rejectedTaxCategories.push({ taxCategory: candidate, status: statusText, code: errCode });
        continue;
      }
      throw new Error(`Paddle POST /products returned ${statusText}: ${rawErr.slice(0, 300)}`);
    }
    if (!product) {
      throw new Error(
        `Paddle POST /products rejected every configured sandbox tax_category (${rejectedTaxCategories.map((r) => `${r.taxCategory}: ${r.status}`).join(", ")})`,
      );
    }
  }

  // Check existing active one-time prices on the product.
  const listedPrices = await paddleJson<PaddlePriceRecord[]>(
    fetchImpl,
    `${apiBase}/prices?product_id=${encodeURIComponent(product.id)}&status=active&per_page=100`,
    { method: "GET", headers },
    200,
  );
  let price = listedPrices.data.find(
    (pr) =>
      pr.unit_price?.amount === built.minorAmount &&
      pr.unit_price?.currency_code === built.currency &&
      (pr.billing_cycle === null || pr.billing_cycle === undefined),
  );
  let priceCreated = false;
  if (!price) {
    const priceBody: PaddlePriceCreateBody = {
      ...built.pricePayloadTemplate,
      product_id: product.id,
    };
    const createdPrice = await paddleJson<PaddlePriceRecord>(
      fetchImpl,
      `${apiBase}/prices`,
      { method: "POST", headers, body: JSON.stringify(priceBody) },
      201,
    );
    price = createdPrice.data;
    priceCreated = true;
  }

  // Verify both created/reused objects by direct readback (200 OK).
  const verifiedProduct = await paddleJson<PaddleProductRecord>(
    fetchImpl,
    `${apiBase}/products/${encodeURIComponent(product.id)}`,
    { method: "GET", headers },
    200,
  );
  const verifiedPrice = await paddleJson<PaddlePriceRecord>(
    fetchImpl,
    `${apiBase}/prices/${encodeURIComponent(price.id)}`,
    { method: "GET", headers },
    200,
  );

  return {
    dryRun: false,
    apiBase,
    taxCategory: actualTaxCategory,
    requestedTaxCategory: built.taxCategory,
    ...(rejectedTaxCategories.length > 0 ? { rejectedTaxCategories } : {}),
    storeProductId: built.storeProductId,
    productSlug: built.productSlug,
    productCreated,
    priceCreated,
    productId: verifiedProduct.data.id,
    priceId: verifiedPrice.data.id,
    productPayload: actualProductPayload,
    pricePayloadTemplate: built.pricePayloadTemplate,
    verifiedStatus: {
      product: verifiedProduct.statusText,
      price: verifiedPrice.statusText,
    },
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const bookFlagIdx = process.argv.indexOf("--book");
  const bookArg = bookFlagIdx >= 0 ? process.argv[bookFlagIdx + 1] : undefined;
  const result = await provisionSandboxSampleProduct({
    bookFile: bookArg ? resolveBookPath(bookArg) : undefined,
    dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
