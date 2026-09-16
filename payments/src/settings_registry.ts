// settings_registry.ts — loader for the data/settings/*.json settings registry
// (audit: data/intel/settings_registry_audit_2026-09-14.md; standing rule: nothing
// hard-coded, settings files only). Every accessor mirrors the committed registry file
// as an inline default, so the payments layer still runs standalone (repo-root cwd or
// missing/unreadable registry) with identical behavior.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_DIRS = [
  path.join(process.cwd(), "data", "settings"), // repo-root run (scripts run from workdir root)
  path.join(HERE, "..", "..", "data", "settings"), // module-relative fallback (standalone)
];

function readRegistryFile(name: string): Record<string, unknown> | undefined {
  for (const dir of CANDIDATE_DIRS) {
    const p = path.join(dir, name);
    try {
      if (!existsSync(p)) continue;
      const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // unreadable/invalid -> try next candidate, else fall back to inline defaults
    }
  }
  return undefined;
}

let warned = false;
function warnFallback(file: string, why: string): void {
  if (warned) return;
  warned = true;
  console.error(`[settings-registry] ${file} ${why} — inline fallbacks in effect (expected at ${CANDIDATE_DIRS[0]})`);
}

// ---------------------------------------------------------------------------
// global.json — paths, endpoints, tool paths, server, shared defaults
// ---------------------------------------------------------------------------
export interface GlobalSettings {
  paths: { sales_ledger: string; reports_dir: string; cache_dir: string; env_file: string };
  endpoints: { openrouter_chat: string; openrouter_stt: string };
  tool_paths: { ffmpeg: string; ffprobe: string; typst_font_dirs: string[] };
  server: { bind_host: string; bind_port: number; max_body_bytes: number };
  user_agent: string;
  defaults: { currency: string };
  payments: { allowed_currencies: string[] };
  landing: { fallbacks: { title: string; creator: string }; disclaimers: string[] };
}

const DEFAULT_GLOBAL: GlobalSettings = {
  paths: {
    sales_ledger: "data/db/sales.jsonl",
    reports_dir: "data/db/reports",
    cache_dir: "data/cache",
    env_file: ".env",
  },
  endpoints: {
    openrouter_chat: "https://openrouter.ai/api/v1/chat/completions",
    openrouter_stt: "https://openrouter.ai/api/v1/audio/transcriptions",
  },
  tool_paths: {
    ffmpeg: "~/.local/bin/ffmpeg",
    ffprobe: "~/.local/bin/ffprobe",
    typst_font_dirs: ["typst_prototype/fonts", "typst_prototype/fonts_variable"],
  },
  server: { bind_host: "127.0.0.1", bind_port: 8787, max_body_bytes: 262144 },
  user_agent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  defaults: { currency: "USD" },
  payments: { allowed_currencies: ["USD"] },
  landing: {
    fallbacks: { title: "Product", creator: "the creator" },
    disclaimers: [
      "This is a digital product (PDF); no physical item will be shipped.",
      "Educational content only — nothing in this document is financial advice. Do your own research.",
    ],
  },
};

function loadGlobal(): GlobalSettings {
  const raw = readRegistryFile("global.json");
  if (!raw) {
    warnFallback("global.json", "missing/unreadable");
    return DEFAULT_GLOBAL;
  }
  const g = raw as Partial<GlobalSettings> & Record<string, unknown>;
  return {
    ...DEFAULT_GLOBAL,
    ...g,
    paths: { ...DEFAULT_GLOBAL.paths, ...(g.paths ?? {}) },
    endpoints: { ...DEFAULT_GLOBAL.endpoints, ...(g.endpoints ?? {}) },
    tool_paths: { ...DEFAULT_GLOBAL.tool_paths, ...(g.tool_paths ?? {}) },
    server: { ...DEFAULT_GLOBAL.server, ...(g.server ?? {}) },
    defaults: { ...DEFAULT_GLOBAL.defaults, ...(g.defaults ?? {}) },
    payments: { ...DEFAULT_GLOBAL.payments, ...(g.payments ?? {}) },
    landing: { ...DEFAULT_GLOBAL.landing, ...(g.landing ?? {}) },
  };
}

export const GLOBAL: GlobalSettings = loadGlobal();

/** Expand a leading `~/` (or bare `~`) to $HOME; non-tilde paths pass through. */
export function expandHome(p: string, home: string): string {
  if (home && (p === "~" || p.startsWith("~/"))) return path.join(home, p.slice(1));
  return p;
}

// ---------------------------------------------------------------------------
// providers.json — payment providers (route tokens, signature, events, secrets)
// ---------------------------------------------------------------------------
export interface PaymentProviderSetting {
  route: string;
  signature_header?: string | null;
  signature_scheme?: string;
  signature_field?: string | null;
  sale_event?: string | null;
  sale_events?: string[];
  refund_events?: string[];
  live_gate?: string | null;
  checkout_param?: string;
  secret_env?: string;
  token_env?: string;
  base_urls?: { sandbox?: string | null; live?: string | null } | null;
  base_urls_note?: string;
  field_map?: Record<string, unknown> | null;
  status?: string;
}

// Inline mirror of data/settings/providers.json "payments" section (fallback contract).
const DEFAULT_PAYMENT_PROVIDERS: Record<string, PaymentProviderSetting> = {
  polar: {
    route: "polar",
    signature_header: "webhook-signature",
    sale_events: ["order.created", "order.paid"],
    secret_env: "POLAR_WEBHOOK_SECRET",
    token_env: "POLAR_ACCESS_TOKEN",
    base_urls: { sandbox: "https://sandbox-api.polar.sh/v1", live: "https://api.polar.sh/v1" },
    field_map: {
      product_id: "data.product_id",
      sale_id: "data.id",
      total_cents: "data.total_amount",
      currency: "data.currency",
      ts: "data.created_at",
      email: "data.customer.email",
    },
  },
  lemonsqueezy: {
    route: "lemonsqueezy",
    signature_header: "x-signature",
    sale_event: "order_created",
    checkout_param: "checkout[custom][product_id]",
    secret_env: "LEMONSQUEEZY_WEBHOOK_SECRET",
    base_urls: { live: "https://api.lemonsqueezy.com/v1", sandbox: null },
    field_map: {
      product_id: "meta.custom_data.product_id",
      sale_id: "data.id",
      total_cents: "data.attributes.total",
      currency: "data.attributes.currency",
      ts: "data.attributes.created_at",
      email: "data.attributes.user_email",
    },
  },
  payhip: {
    route: "payhip",
    signature_header: null,
    signature_field: "signature",
    signature_scheme: "in-payload sha256-hex: body.signature = sha256(Payhip API key) hex — NOT a body HMAC (help.payhip.com/article/115-webhooks, updated 2026-07-22)",
    sale_events: ["paid"],
    refund_events: ["refunded"],
    secret_env: "PAYHIP_WEBHOOK_SECRET",
    base_urls: { live: "https://payhip.com", sandbox: null },
    field_map: {
      sale_id: "id",
      total_cents: "price",
      currency: "currency",
      ts_epoch_s: "date",
      email: "email",
      product_id: "items[0].product_id",
      refund_amount_minor: "amount_refunded",
      refund_ts_epoch_s: "date_refunded",
      original_ts_epoch_s: "date_created",
    },
  },
  paddle: {
    route: "paddle",
    signature_header: "paddle-signature",
    sale_event: "transaction.completed",
    secret_env: "PADDLE_WEBHOOK_SECRET",
    base_urls: { sandbox: "https://sandbox-api.paddle.com", live: "https://api.paddle.com" },
    field_map: {
      product_id: "data.custom_data.product_id",
      sale_id: "data.id",
      total_cents: "data.details.totals.total",
      currency: "data.currency_code",
      ts_epoch_s: "data.changed_at",
      email: "data.custom_data.email",
    },
  },
  fastspring: {
    route: "fastspring",
    signature_header: "x-fs-signature",
    signature_scheme: "hmac-sha256-base64: `x-fs-signature` = base64(HMAC-SHA256(raw_body, secret)) (developer.fastspring.com/reference/message-security)",
    sale_events: ["order.completed"],
    refund_events: ["return.created"],
    live_gate: "data.live",
    secret_env: "FASTSPRING_WEBHOOK_SECRET",
    base_urls: { live: "https://api.fastspring.com", sandbox: null },
    field_map: {
      sale_id: "data.id",
      reference: "data.reference",
      total: "data.total",
      currency: "data.currency",
      ts_ms: "data.changed",
      email: "data.customer.email",
      product_id: "data.items[0].product",
      refund_id: "data.return",
      refund_sale_id: "data.original.order",
      refund_total: "data.totalReturn",
      refund_original_total: "data.original.total",
      refund_ts_ms: "data.changed",
    },
  },
  fungies: {
    route: "fungies",
    signature_header: "x-fngs-signature",
    signature_scheme:
      "hmac-sha256-hex: `x-fngs-signature: sha256_<hex>` = HMAC-SHA256(raw_body, webhook_secret) hex (docs.fungies.io/developers/webhooks/setup, verified 2026-09-15)",
    sale_events: ["payment_success"],
    secret_env: "FUNGIES_WEBHOOK_SECRET",
    base_urls: { sandbox: "https://api.stage.fungies.net/v0", live: "https://api.fungies.io/v0" },
    base_urls_note: "TLD split verified 2026-09-15: prod api.fungies.io vs sandbox api.stage.fungies.NET (docs.fungies.io/api-reference/introduction + stage-hosted OpenAPI)",
    field_map: {
      sale_id: "data.payment.id",
      total_cents: "data.payment.value",
      currency: "data.payment.currency",
      ts_ms: "data.payment.createdAt",
      email: "data.user.email",
      custom_fields_product_id: "product_id",
      product_internal_id: "items[].product.internalId",
      product_id: "items[].product.id",
    },
  },
};

function loadPaymentProviders(): Record<string, PaymentProviderSetting> {
  const raw = readRegistryFile("providers.json");
  if (!raw) {
    warnFallback("providers.json", "missing/unreadable");
    return DEFAULT_PAYMENT_PROVIDERS;
  }
  const payments = raw["payments"];
  if (!payments || typeof payments !== "object" || Array.isArray(payments)) {
    warnFallback("providers.json", "has no usable 'payments' section");
    return DEFAULT_PAYMENT_PROVIDERS;
  }
  return payments as Record<string, PaymentProviderSetting>;
}

export const PAYMENT_PROVIDERS: Record<string, PaymentProviderSetting> = loadPaymentProviders();

export function paymentProviderSetting(name: string): PaymentProviderSetting | undefined {
  return PAYMENT_PROVIDERS[name];
}

export function isRegisteredPaymentProvider(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAYMENT_PROVIDERS, name);
}

// ---------------------------------------------------------------------------
// providers.json "data" section — non-payment API providers (hikerapi, youtube,
// decodo, openrouter). Inline mirror of the committed registry (fallback contract).
// ---------------------------------------------------------------------------
export interface DataProviderSetting {
  base?: string;
  auth_header?: string;
  key_env?: string;
  auth_env?: string;
  endpoints?: Record<string, string>;
  comments_quota_per_100?: number;
  scraping_endpoint?: string;
  chat?: string;
}

const DEFAULT_DATA_PROVIDERS: Record<string, DataProviderSetting> = {
  hikerapi: {
    base: "https://api.hikerapi.com",
    auth_header: "x-access-key",
    key_env: "HIKERAPI_API_KEY",
    endpoints: { user_by_username: "/v1/user/by/username", medias_chunk: "/v1/user/medias/chunk" },
  },
  youtube: {
    base: "https://www.googleapis.com/youtube/v3",
    key_env: "YOUTUBE_API_KEY",
    endpoints: { videos: "/videos", channels: "/channels" },
    comments_quota_per_100: 1,
  },
  decodo: {
    scraping_endpoint: "https://scraper-api.decodo.com/v2/scrape",
    auth_env: "DECODO_SCRAPING_API_AUTH",
  },
  openrouter: {
    chat: "https://openrouter.ai/api/v1/chat/completions",
    key_env: "OPENROUTER_API_KEY",
  },
};

function loadDataProviders(): Record<string, DataProviderSetting> {
  const raw = readRegistryFile("providers.json");
  if (raw) {
    const data = raw["data"];
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, DataProviderSetting>;
    }
  }
  return DEFAULT_DATA_PROVIDERS;
}

export const DATA_PROVIDERS: Record<string, DataProviderSetting> = loadDataProviders();

export function dataProviderSetting(name: string): DataProviderSetting | undefined {
  return DATA_PROVIDERS[name];
}

/** Allowed sale currencies (global.json payments.allowed_currencies; default USD-only). */
export function allowedCurrencies(): string[] {
  const list = GLOBAL.payments.allowed_currencies;
  return Array.isArray(list) && list.length > 0 ? list.map(String) : ["USD"];
}

export function isAllowedCurrency(currency: string): boolean {
  return allowedCurrencies().map((c) => c.toUpperCase()).includes(String(currency).toUpperCase());
}

/** Resolve a dotted path (e.g. "meta.custom_data.product_id") against a parsed webhook body. */
export function getPath(obj: unknown, dotted: string | undefined): unknown {
  if (typeof dotted !== "string" || dotted === "") return undefined;
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
