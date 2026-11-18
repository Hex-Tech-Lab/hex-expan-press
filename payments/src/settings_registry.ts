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

type RegistryRead = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; data: Record<string, unknown> };

/** Reads a settings file across candidate directories. If any candidate exists but cannot be
 *  parsed or is not a JSON object, it returns "invalid" (fail-closed: a corrupt primary must never
 *  fall back to a secondary copy). */
function readRegistryResult(name: string): RegistryRead {
  let sawInvalid = false;
  let firstOk: Record<string, unknown> | null = null;
  for (const dir of CANDIDATE_DIRS) {
    const p = path.join(dir, name);
    try {
      if (!existsSync(p)) continue;
      const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (!firstOk) {
          firstOk = parsed as Record<string, unknown>;
        }
        continue;
      }
      console.error(`[settings-registry] ${p} is not a JSON object — skipped`);
      sawInvalid = true;
    } catch (err) {
      console.error(`[settings-registry] ${p} unreadable/invalid JSON — skipped:`, err instanceof Error ? err.message : err);
      sawInvalid = true;
    }
  }
  if (sawInvalid) return { kind: "invalid" };
  if (firstOk) return { kind: "ok", data: firstOk };
  return { kind: "missing" };
}

function readRegistryFile(name: string): Record<string, unknown> | undefined {
  const r = readRegistryResult(name);
  return r.kind === "ok" ? r.data : undefined;
}

function warnFallback(file: string, why: string): void {
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
  payments: {
    allowed_currencies: string[];
    webhook_tolerance_seconds: number;
    webhook_lock_ttl_seconds: number;
    webhook_lock_fence_ttl_seconds: number;
    webhook_lock_sale_prefix: string;
    webhook_lock_refund_prefix: string;
    webhook_lock_fence_suffix: string;
    http_timeout_ms: number; // webhook-internal call budget: Paddle customer-email lookup AND the 503 audit insert (must stay short)
    sync_http_timeout_ms: number; // operator CLI (sync_book_identity) calls to Supabase/Paddle
    review_queue_page_size: number; // listManualReviewRefunds default page/limit
    /** Retry-After seconds sent on 503 webhook responses (in-flight AND generic 503 paths). */
    retry_after_seconds: number;
    paddle: { api_base: { production: string; sandbox: string }; js_cdn_url: string };
    /** Creem TEST mode is accepted only when this is true, creem_test_database_ref is non-empty,
     *  AND new URL(SUPABASE_URL).hostname equals `${creem_test_database_ref}.supabase.co`.
     *  Production has no global.json, so this stays false there. Test-only; see creem.adapter.ts. */
    creem_accept_test_mode: boolean;
    /** Project ref of the separate test database (branch) that test-mode Creem events may write to. Empty = refuse. */
    creem_test_database_ref: string;
    /** Explicit opt-in for sandbox checkout acceptance (sandbox checkout_mode and sandbox.* rail hosts)
     *  on non-production runtimes. Default false (fail closed); production always refuses regardless. */
    sandbox_checkout_enabled: boolean;
  };
  /** Buyer-facing storefront links. `b2c_landing_url` is the logo target on the thank-you page. */
  storefront: { b2c_landing_url: string };
  /** Creator handle policy (web/src/lib/handle-policy.ts). Set once at account creation; immutable after. */
  handles: { min_length: number; max_length: number; separator: string; reserved: string[]; profanity_whitelist: string[] };
  /** Product slug rule (ADR 0065): same shape as handles. Unique per creator (products_creator_id_slug_key);
   *  platform-wide products_slug_key was reverted and is dropped by supabase/migrations/20261117110000_products_slug_convergence.sql. */
product_slug: { min_length: number; max_length: number; separator: string };
  landing: { fallbacks: { title: string; creator: string }; disclaimers: string[] };
  /** Admin API allowlist + pagination (admin audit-log route). */
  admin: {
    /** Supabase auth user ids permitted to call admin API routes. Empty => fail closed (403 for everyone). */
    admin_user_ids: string[];
    /** Default page size for admin audit-log listing. */
    audit_log_page_size: number;
  };
  /** Buyer delivery: download_events links, Dub short links, signed release URLs, delivery_sends kind. */
  delivery: {
    bucket: string;
    link_ttl_days: number;
    signed_url_seconds: number;
    short_domain: string;
    send_kind: string;
    /** A send claim still in 'claimed' this long after it was made is logged as STUCK (never resent: at-most-once). */
    stuck_claim_after_seconds: number;
    /** Most rows listStuckDeliveryClaims returns (oldest first). Bounds the operator reconcile query. */
    stuck_claim_list_limit: number;
    /** NAME of the env var holding the base64 32-byte AES-256-GCM key that encrypts a held claim's stored buyer email. */
    link_key_env: string;
  };
  /** Transactional email (Resend). `from` must be on `sending_domain` (DKIM-verified in Resend). */
  email: {
    from: string;
    reply_to: string;
    sending_domain: string;
    retryable_error_names: string[];
  };
  portal: { jwt_clock_skew_retry_delay_ms: number };
  consent: { text_version: string; evidence_path: { user_id_pattern: string; envelope_id_pattern: string } };
  /** Daily usage watch (scripts/ops/usage_watch.ts). Limits are the plan limits we are on (Vercel Hobby, Supabase Free org,
   *  Upstash pay-as-you-go); warn_ratio is the fraction of a limit at which the watch reports WARN and exits non-zero. */
  usage_watch: UsageWatchSettings;
}

export interface UsageWatchSettings {
  warn_ratio: number;
  /** Per-request budget for every usage-watch HTTP or CLI call. */
  timeout_ms: number;
  endpoints: { supabase_api: string; upstash_api: string; vercel_cli: string };
  vercel: { team_id: string; max_pages: number; deployments_per_day: number; deployments_per_hour: number; fluid_active_cpu_hours: number };
  supabase: { db_size_bytes: number; egress_bytes: number; file_storage_bytes: number };
  upstash: { monthly_commands: number; monthly_bandwidth_bytes: number; memory_bytes: number };
}

export const DEFAULT_GLOBAL: GlobalSettings = {
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
  payments: {
    allowed_currencies: ["USD"],
    webhook_tolerance_seconds: 300,
    webhook_lock_ttl_seconds: 300,
    // Lock/fence defaults live in DEFAULT_GLOBAL because data/ is gitignored and absent in production.
    webhook_lock_fence_ttl_seconds: 604800,
    webhook_lock_sale_prefix: "lock:sale:",
    webhook_lock_refund_prefix: "lock:refund:",
    webhook_lock_fence_suffix: ":fence",
    http_timeout_ms: 5000,
    sync_http_timeout_ms: 30000,
    review_queue_page_size: 200,
    retry_after_seconds: 30,
    creem_accept_test_mode: false,
    creem_test_database_ref: "",
    sandbox_checkout_enabled: false,
    paddle: {
      api_base: { production: "https://api.paddle.com", sandbox: "https://sandbox-api.paddle.com" },
      js_cdn_url: "https://cdn.paddle.com/paddle/v2/paddle.js",
    },
  },
  // Home target for every buyer-side logo and home link (thank-you page, checkout). Absolute, so a buyer on
  // pay.expanpress.com also lands on the B2C landing, never on the B2B root. The B2C landing is /books on the main site.
  storefront: { b2c_landing_url: "https://expanpress.com/books" },
  // Our handle rules, not a platform's (Instagram allows 1-30, Facebook requires 5). Reserved words are never assignable.
  handles: {
    min_length: 3,
    max_length: 30,
    // The only separator. Letters and digits between single separators; no leading, trailing or doubled separator.
    separator: "_",
    reserved: [
      "admin", "root", "support", "expanpress", "api", "books", "creator", "creators", "login", "signin",
      "signup", "thanks", "help", "legal", "privacy", "terms", "www", "official", "staff", "system",
    ],
    // Ordinary words that contain a blacklisted substring. Merged with the obscenity preset's own whitelist.
    profanity_whitelist: [
      "classic", "assess", "assessment", "assist", "assistant", "assume", "bass", "class", "glass", "grass", "pass", "passage",
    ],
  },
  // Product slug rule (ADR 0065). Same shape as handles. Unique per creator (products_creator_id_slug_key);
  // platform-wide products_slug_key was reverted and is dropped by supabase/migrations/20261117110000_products_slug_convergence.sql.
  product_slug: { min_length: 3, max_length: 30, separator: "_" },
  landing: {
    fallbacks: { title: "Product", creator: "the creator" },
    disclaimers: [
      "This is a digital product (PDF); no physical item will be shipped.",
      "Educational content only — nothing in this document is financial advice. Do your own research.",
    ],
  },
  // Buyer delivery (download_events, delivery_sends). The bucket holds release files only, never review copies.
  delivery: {
    bucket: "release-files",
    link_ttl_days: 7,
    signed_url_seconds: 300,
    short_domain: "go.expanpress.com",
    // Default send_kind lives in DEFAULT_GLOBAL because data/ is gitignored and absent in production.
    send_kind: "buyer_receipt",
    // Above the email deadline (payments.http_timeout_ms) and the webhook lock TTL, so a live send is never reported stuck.
    stuck_claim_after_seconds: 900,
    stuck_claim_list_limit: 500,
    // Only the env var NAME is a setting; the key value never lives in the registry or the repo.
    link_key_env: "DELIVERY_LINK_KEY",
  },
  email: {
    from: "ExpanPress <support@esign.expanpress.com>",
    reply_to: "support@expanpress.com", // has MX (registrar forwarding); the esign/ops subdomains do not
    sending_domain: "expanpress.com",
    retryable_error_names: [
      "rate_limit_exceeded",
      "application_error",
      "internal_server_error",
      "daily_quota_exceeded",
    ],
  },
  portal: { jwt_clock_skew_retry_delay_ms: 350 },
  admin: { admin_user_ids: [], audit_log_page_size: 50 },
  consent: {
    text_version: "v1.1",
    // Object-path rules for consent evidence (`<userId>/<envelopeId>.pdf`). Enforced before any upload.
    // Mirrors the DB CHECK on consents.evidence_path (lowercase UUID directory, bounded envelope name).
    evidence_path: {
      user_id_pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      envelope_id_pattern: "^[A-Za-z0-9_-]{1,128}$",
    },
  },
  usage_watch: {
    warn_ratio: 0.8,
    timeout_ms: 20000,
    endpoints: { supabase_api: "https://api.supabase.com", upstash_api: "https://api.upstash.com", vercel_cli: "vercel" },
    // Vercel Hobby: 100 deployments/day (vercel.com/docs/plans/hobby), 100 per hour (vercel.com/docs/limits),
    // Fluid Active CPU 4 h/month (vercel.com/docs/functions/limitations). Hobby exposes no usage API; see usage_watch.ts.
    vercel: { team_id: "team_vgnBI2s3ynPBzQdOLqhGvBnK", max_pages: 10, deployments_per_day: 100, deployments_per_hour: 100, fluid_active_cpu_hours: 4 },
    // Supabase Free org: 500 MB database, 5 GB egress, 1 GB file storage (supabase.com/pricing).
    supabase: { db_size_bytes: 524288000, egress_bytes: 5368709120, file_storage_bytes: 1073741824 },
    // Upstash pay-as-you-go (no hard cap). monthly_commands is the 500K Free-tier quota kept as a spend trip-wire;
    // monthly_bandwidth is the 200 GB PAYG free bandwidth (upstash.com/pricing/redis); memory is the API db_memory_threshold (3 GB).
    upstash: { monthly_commands: 500000, monthly_bandwidth_bytes: 214748364800, memory_bytes: 3221225472 },
  },
};

// Bounds for the admin tunables (feature code must never hard-code them).
export const ADMIN_LIMITS = {
  audit_log_page_size: { min: 1, max: 500 },
  admin_user_ids: { max: 100 }, // sanity cap on allowlist size
} as const;

// Sign-in redirect hosts outside production (Argon F-11). The request host is trusted only when it
// is this project's own Vercel deployment (production alias, git-branch alias, or per-deployment
// host) or localhost. Production uses the canonical allowlist in web/app/creator/signin/actions.ts.
export const AUTH_REDIRECT_HOSTS = {
  preview_host_pattern: /^hex-expan-press(?:-git-[a-z0-9-]+|-[a-z0-9]+)?-techhypexps-projects\.vercel\.app$/,
  local_host_pattern: /^localhost(?::\d{1,5})?$/,
} as const;

// Named bounds for the payments tunables (lives in the registry module by design —
// feature code must never hard-code them). sync_http_timeout max 120000 keeps far
// clear of Node's 2147483647 timer limit.
export const PAYMENTS_LIMITS = {
  webhook_tolerance_seconds: { min: 60, max: 900 },
  webhook_lock_ttl_seconds: { min: 60, max: 3600 },
  webhook_lock_fence_ttl_seconds: { min: 300, max: 2592000 },
  http_timeout_ms: { min: 1000, max: 30000 },
  sync_http_timeout_ms: { min: 1000, max: 120000 },
  review_queue_page_size: { min: 1, max: 1000 },
  retry_after_seconds: { min: 1, max: 600 },
} as const;

function intInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

// Accepts only the exact canonical Paddle host after stripping trailing slashes.
// Rejects credentials, non-default port, any path/query/fragment — Bearer tokens
// must never be sent to another host.
function isCanonicalPaddleApiUrl(v: unknown, expected: string): v is string {
  if (typeof v !== "string") return false;
  const s = v.replace(/\/+$/, "");
  if (s !== expected) return false;
  try {
    const u = new URL(s);
    if (u.username || u.password || u.port || u.search || u.hash) return false;
    if (u.pathname !== "/" && u.pathname !== "") return false;
    return true;
  } catch {
    return false;
  }
}

function isPaddleJsCdnUrl(v: unknown): v is string {
  return v === "https://cdn.paddle.com/paddle/v2/paddle.js";
}

// ISO 4217 codes our providers settle. Membership is explicit — shape checks
// ( /^[A-Z]{3}$/ ) accept nonsense like "ZZZ".
export const SUPPORTED_ISO_4217: ReadonlySet<string> = new Set([
  "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK",
  "PLN", "CZK", "HUF", "JPY", "SGD", "HKD", "INR", "BRL", "MXN", "ZAR",
  "AED", "SAR", "EGP", "TRY", "KRW", "CNY", "ILS", "ARS", "COP", "CLP",
  "PHP", "THB", "TWD", "UAH", "RUB",
] as const);

function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== "string" || !v.startsWith("https://")) return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

export function loadPaymentsSection(raw: Record<string, unknown> | undefined): GlobalSettings["payments"] {
  const defaults = DEFAULT_GLOBAL.payments;
  if (!raw) return defaults;
  const p = raw as Partial<GlobalSettings["payments"]> & Record<string, unknown>;
  const paddle = (p.paddle ?? {}) as Partial<GlobalSettings["payments"]["paddle"]>;
  const apiBase = (paddle.api_base ?? {}) as Partial<GlobalSettings["payments"]["paddle"]["api_base"]>;
  const fallbacks: string[] = [];
  // Warn ONLY for keys explicitly present and invalid; omitted keys default silently.
  const num = (key: keyof typeof PAYMENTS_LIMITS): number => {
    if (!(key in p)) return defaults[key];
    const v = p[key];
    const { min, max } = PAYMENTS_LIMITS[key];
    if (intInRange(v, min, max)) return v;
    fallbacks.push(key);
    return defaults[key];
  };
  const webhookTolerance = num("webhook_tolerance_seconds");
  const webhookLockTtl = num("webhook_lock_ttl_seconds");
  const webhookLockFenceTtl = num("webhook_lock_fence_ttl_seconds");
  const keyToken = (key: "webhook_lock_sale_prefix" | "webhook_lock_refund_prefix" | "webhook_lock_fence_suffix"): string => {
    if (!(key in p)) return defaults[key];
    const v = p[key];
    if (typeof v === "string" && v.length > 0 && !/\s/.test(v)) return v;
    fallbacks.push(key);
    return defaults[key];
  };
  const webhookLockSalePrefix = keyToken("webhook_lock_sale_prefix");
  const webhookLockRefundPrefix = keyToken("webhook_lock_refund_prefix");
  const webhookLockFenceSuffix = keyToken("webhook_lock_fence_suffix");
  const httpTimeout = num("http_timeout_ms");
  const syncHttpTimeout = num("sync_http_timeout_ms");
  // Validate BEFORE the fallback warning below, so an invalid value is reported, not silently defaulted.
  const reviewQueuePageSize = num("review_queue_page_size");
  const retryAfterSeconds = num("retry_after_seconds");
  const paddleUrl = (v: unknown, expected: string, label: string, validateAndNormalize: (x: unknown) => string | null): string => {
    const normalized = v === undefined ? null : validateAndNormalize(v);
    if (normalized !== null) return normalized;
    if (v !== undefined) fallbacks.push(label);
    return expected;
  };
  const apiProduction = paddleUrl(
    apiBase.production, defaults.paddle.api_base.production, "paddle.api_base.production",
    (x) => isCanonicalPaddleApiUrl(x, "https://api.paddle.com") ? (x as string).replace(/\/+$/, "") : null,
  );
  const apiSandbox = paddleUrl(
    apiBase.sandbox, defaults.paddle.api_base.sandbox, "paddle.api_base.sandbox",
    (x) => isCanonicalPaddleApiUrl(x, "https://sandbox-api.paddle.com") ? (x as string).replace(/\/+$/, "") : null,
  );
  const jsCdn = paddleUrl(paddle.js_cdn_url, defaults.paddle.js_cdn_url, "paddle.js_cdn_url", (x) => (isPaddleJsCdnUrl(x) ? (x as string) : null));
  let currencies = defaults.allowed_currencies;
  if (p.allowed_currencies !== undefined) {
    const list = Array.isArray(p.allowed_currencies)
      ? p.allowed_currencies.map(String)
      : null;
    if (list && list.length > 0 && list.every((c) => SUPPORTED_ISO_4217.has(c))) {
      currencies = list;
    } else {
      fallbacks.push("allowed_currencies");
    }
  }
  let sandboxCheckoutEnabled = defaults.sandbox_checkout_enabled;
  if ("sandbox_checkout_enabled" in p) {
    if (typeof p.sandbox_checkout_enabled === "boolean") {
      sandboxCheckoutEnabled = p.sandbox_checkout_enabled;
    } else {
      fallbacks.push("sandbox_checkout_enabled");
    }
  }
  if (fallbacks.length > 0) warnFallback("global.json", `invalid payments values for ${fallbacks.join(", ")}`);
  return {
    allowed_currencies: currencies,
    webhook_tolerance_seconds: webhookTolerance,
    webhook_lock_ttl_seconds: webhookLockTtl,
    webhook_lock_fence_ttl_seconds: webhookLockFenceTtl,
    webhook_lock_sale_prefix: webhookLockSalePrefix,
    webhook_lock_refund_prefix: webhookLockRefundPrefix,
    webhook_lock_fence_suffix: webhookLockFenceSuffix,
    http_timeout_ms: httpTimeout,
    sync_http_timeout_ms: syncHttpTimeout,
    review_queue_page_size: reviewQueuePageSize,
    retry_after_seconds: retryAfterSeconds,
    paddle: { api_base: { production: apiProduction, sandbox: apiSandbox }, js_cdn_url: jsCdn },
    creem_accept_test_mode: p.creem_accept_test_mode === true,
    creem_test_database_ref: typeof p.creem_test_database_ref === "string" ? p.creem_test_database_ref.trim() : "",
    sandbox_checkout_enabled: sandboxCheckoutEnabled,
  };
}

function loadGlobal(): GlobalSettings {
  const raw = readRegistryFile("global.json");
  if (!raw) {
    warnFallback("global.json", "missing/unreadable");
    // Production deploys no global.json: env overrides (ADMIN_USER_IDS) must still apply.
    return { ...DEFAULT_GLOBAL, payments: loadPaymentsSection(undefined), admin: loadAdminSection(undefined) };
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
    payments: loadPaymentsSection(g.payments as Record<string, unknown> | undefined),
    delivery: loadDeliverySection(g.delivery as Record<string, unknown> | undefined),
    landing: { ...DEFAULT_GLOBAL.landing, ...(g.landing ?? {}) },
    storefront: { ...DEFAULT_GLOBAL.storefront, ...(g.storefront ?? {}) },
    handles: { ...DEFAULT_GLOBAL.handles, ...(g.handles ?? {}) },
    product_slug: { ...DEFAULT_GLOBAL.product_slug, ...(g.product_slug ?? {}) },
    email: loadEmailSection(g.email as Record<string, unknown> | undefined),
    portal: { ...DEFAULT_GLOBAL.portal, ...(g.portal ?? {}) },
    admin: loadAdminSection(g.admin as Record<string, unknown> | undefined),
    consent: { ...DEFAULT_GLOBAL.consent, ...(g.consent ?? {}) },
    usage_watch: loadUsageWatchSection(g.usage_watch as Record<string, unknown> | undefined),
  };
}

/** Bounds for the usage watch tunables. warn_ratio stays strictly between 0.5 and 0.99 so WARN can fire before a hard limit. */
export const USAGE_WATCH_LIMITS = {
  warn_ratio: { min: 0.5, max: 0.99 },
} as const;

/**
 * The only HTTPS origins usage watch may send an Authorization header to. Not a tunable: a registry override that names
 * any other host is refused at load time (the default is used), so a tampered settings file cannot receive the
 * Supabase or Upstash credentials. vercel_cli is a command name, not a URL, and is not listed here.
 */
export const USAGE_WATCH_ENDPOINT_ORIGINS = {
  supabase_api: "https://api.supabase.com",
  upstash_api: "https://api.upstash.com",
} as const;

/** Largest delay Node timers accept (setTimeout and AbortSignal.timeout clamp or misfire above it). */
const MAX_TIMER_MS = 2147483647;

/** Non-overridable invariant mirroring the DB CHECK on consents.evidence_path. The registry rules may only tighten this. */
export const CONSENT_EVIDENCE_SEGMENT_CONTRACT = {
  userId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  envelopeId: /^[A-Za-z0-9_-]{1,128}$/,
} as const;

/** usage_watch: deep-merge over the defaults. Every number must be a finite positive value; a bad value falls back
 *  to its default (with a warning) instead of disabling the watch. */
export function loadUsageWatchSection(raw: Record<string, unknown> | undefined): UsageWatchSettings {
  const defaults = DEFAULT_GLOBAL.usage_watch;
  if (!raw) return defaults;
  const fallbacks: string[] = [];
  const pick = (candidate: unknown, fallback: number, key: string, ok: (value: number) => boolean): number => {
    if (typeof candidate === "number" && Number.isFinite(candidate) && ok(candidate)) return candidate;
    if (candidate !== undefined) fallbacks.push(key);
    return fallback;
  };
  const positive = (value: number): boolean => value > 0;
  const sub = (name: "vercel" | "supabase" | "upstash"): Record<string, unknown> =>
    (raw[name] && typeof raw[name] === "object" ? raw[name] : {}) as Record<string, unknown>;
  const v = sub("vercel");
  const s = sub("supabase");
  const u = sub("upstash");
  const endpoints = (raw.endpoints && typeof raw.endpoints === "object" ? raw.endpoints : {}) as Record<string, unknown>;
  const str = (candidate: unknown, fallback: string, key: string): string => {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
    if (candidate !== undefined) fallbacks.push(key);
    return fallback;
  };
  // An HTTPS origin on the allowlist, with no userinfo and no path. Anything else falls back to the default.
  const allowedOrigin = (candidate: unknown, fallback: string, key: "supabase_api" | "upstash_api"): string => {
    if (candidate === undefined) return fallback;
    const allowed = USAGE_WATCH_ENDPOINT_ORIGINS[key];
    if (typeof candidate === "string") {
      try {
        const url = new URL(candidate);
        const bare = url.protocol === "https:" && url.origin === allowed && url.username === "" && url.password === "" && (url.pathname === "/" || url.pathname === "") && url.search === "" && url.hash === "";
        if (bare) return allowed;
      } catch {
        // Not a URL: falls through to the fallback below.
      }
    }
    fallbacks.push(`endpoints.${key}`);
    return fallback;
  };
  // timeout_ms feeds AbortSignal.timeout and execFile: it must be an integer that Node timers accept.
  const timerMs = (candidate: unknown): boolean => Number.isSafeInteger(candidate) && (candidate as number) >= 1 && (candidate as number) <= MAX_TIMER_MS;
  const out: UsageWatchSettings = {
    warn_ratio: pick(raw.warn_ratio, defaults.warn_ratio, "warn_ratio", (value) => value >= USAGE_WATCH_LIMITS.warn_ratio.min && value <= USAGE_WATCH_LIMITS.warn_ratio.max),
    timeout_ms: pick(raw.timeout_ms, defaults.timeout_ms, "timeout_ms", timerMs),
    endpoints: {
      supabase_api: allowedOrigin(endpoints.supabase_api, defaults.endpoints.supabase_api, "supabase_api"),
      upstash_api: allowedOrigin(endpoints.upstash_api, defaults.endpoints.upstash_api, "upstash_api"),
      vercel_cli: str(endpoints.vercel_cli, defaults.endpoints.vercel_cli, "endpoints.vercel_cli"),
    },
    vercel: {
      team_id: str(v.team_id, defaults.vercel.team_id, "vercel.team_id"),
      max_pages: pick(v.max_pages, defaults.vercel.max_pages, "vercel.max_pages", positive),
      deployments_per_day: pick(v.deployments_per_day, defaults.vercel.deployments_per_day, "vercel.deployments_per_day", positive),
      deployments_per_hour: pick(v.deployments_per_hour, defaults.vercel.deployments_per_hour, "vercel.deployments_per_hour", positive),
      fluid_active_cpu_hours: pick(v.fluid_active_cpu_hours, defaults.vercel.fluid_active_cpu_hours, "vercel.fluid_active_cpu_hours", positive),
    },
    supabase: {
      db_size_bytes: pick(s.db_size_bytes, defaults.supabase.db_size_bytes, "supabase.db_size_bytes", positive),
      egress_bytes: pick(s.egress_bytes, defaults.supabase.egress_bytes, "supabase.egress_bytes", positive),
      file_storage_bytes: pick(s.file_storage_bytes, defaults.supabase.file_storage_bytes, "supabase.file_storage_bytes", positive),
    },
    upstash: {
      monthly_commands: pick(u.monthly_commands, defaults.upstash.monthly_commands, "upstash.monthly_commands", positive),
      monthly_bandwidth_bytes: pick(u.monthly_bandwidth_bytes, defaults.upstash.monthly_bandwidth_bytes, "upstash.monthly_bandwidth_bytes", positive),
      memory_bytes: pick(u.memory_bytes, defaults.upstash.memory_bytes, "upstash.memory_bytes", positive),
    },
  };
  if (fallbacks.length > 0) warnFallback("global.json", `invalid usage_watch values for ${fallbacks.join(", ")}`);
  return out;
}

export function consentTextVersion(): string {
  const v = GLOBAL.consent?.text_version;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : DEFAULT_GLOBAL.consent.text_version;
}

/**
 * Compiled consent-evidence path rules. A missing or empty override falls back to the default; an override
 * that is not a valid regex throws, which fails closed (the caller refuses before any upload).
 */
export function consentEvidencePathRules(): { userId: RegExp; envelopeId: RegExp } {
  const configured = GLOBAL.consent?.evidence_path;
  const defaults = DEFAULT_GLOBAL.consent.evidence_path;
  const pick = (value: unknown, fallback: string): string => (typeof value === "string" && value.length > 0 ? value : fallback);
  return {
    userId: new RegExp(pick(configured?.user_id_pattern, defaults.user_id_pattern)),
    envelopeId: new RegExp(pick(configured?.envelope_id_pattern, defaults.envelope_id_pattern)),
  };
}

export const PORTAL_JWT_SKEW_LIMITS = { min: 250, max: 500 } as const;

/** admin section: shallow merge + validation. admin_user_ids must be an array of
 *  non-empty UUID-ish strings (shape-checked: hex/dash), bounded by ADMIN_LIMITS;
 *  audit_log_page_size clamps into its bounds. Env overrides:
 *  ADMIN_USER_IDS (comma-separated), ADMIN_AUDIT_LOG_PAGE_SIZE. */
export function loadAdminSection(raw: Record<string, unknown> | undefined): GlobalSettings["admin"] {
  const defaults = DEFAULT_GLOBAL.admin;
  const r = (raw ?? {}) as Partial<GlobalSettings["admin"]> & Record<string, unknown>;
  const fallbacks: string[] = [];
  let userIds = defaults.admin_user_ids;
  // Env wins over global.json (production deploys no global.json; the env is the operator's override).
  // An empty / commas-only ADMIN_USER_IDS counts as unset, so it can't silently blank a file allowlist.
  const envIds = process.env.ADMIN_USER_IDS?.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const rawIds = envIds && envIds.length > 0 ? envIds : r.admin_user_ids;
  if (rawIds !== undefined) {
    if (
      Array.isArray(rawIds)
      && rawIds.length <= ADMIN_LIMITS.admin_user_ids.max
      && rawIds.every((id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    ) {
      userIds = rawIds.map((id) => id.toLowerCase()); // Supabase auth ids are lowercase
    } else {
      fallbacks.push("admin_user_ids");
    }
  }
  let pageSize = defaults.audit_log_page_size;
  const rawSize = process.env.ADMIN_AUDIT_LOG_PAGE_SIZE !== undefined ? Number(process.env.ADMIN_AUDIT_LOG_PAGE_SIZE) : r.audit_log_page_size;
  if (intInRange(rawSize, ADMIN_LIMITS.audit_log_page_size.min, ADMIN_LIMITS.audit_log_page_size.max)) {
    pageSize = rawSize;
  } else if (rawSize !== undefined) {
    fallbacks.push("audit_log_page_size");
  }
  if (fallbacks.length > 0) warnFallback("global.json", `invalid admin values for ${fallbacks.join(", ")}`);
  return { admin_user_ids: userIds, audit_log_page_size: pageSize };
}

/** Clamp a raw jwt_clock_skew_retry_delay_ms into [250,500]; non-finite/missing -> 350. */
export function clampJwtSkewDelay(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_GLOBAL.portal.jwt_clock_skew_retry_delay_ms;
  return Math.min(Math.max(v, PORTAL_JWT_SKEW_LIMITS.min), PORTAL_JWT_SKEW_LIMITS.max);
}

/** Clamped portal.jwt_clock_skew_retry_delay_ms from the loaded registry. */
export function jwtSkewRetryDelayMs(): number {
  return clampJwtSkewDelay(GLOBAL.portal?.jwt_clock_skew_retry_delay_ms);
}

export function loadDeliverySection(raw: Record<string, unknown> | undefined): GlobalSettings["delivery"] {
  const defaults = DEFAULT_GLOBAL.delivery;
  if (!raw) return defaults;
  const record = raw as Partial<GlobalSettings["delivery"]> & Record<string, unknown>;
  const fallbacks: string[] = [];
  const str = (key: "bucket" | "short_domain" | "send_kind" | "link_key_env"): string => {
    if (!(key in record)) return defaults[key];
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim() !== "" && candidate === candidate.trim()) return candidate;
    fallbacks.push(key);
    return defaults[key];
  };
  const posInt = (key: "link_ttl_days" | "signed_url_seconds" | "stuck_claim_after_seconds" | "stuck_claim_list_limit", min: number, max: number): number => {
    if (!(key in record)) return defaults[key];
    const candidate = record[key];
    if (intInRange(candidate, min, max)) return candidate;
    fallbacks.push(key);
    return defaults[key];
  };
  // An env var name, never a value: an invalid name falls back to the default (and warns) so the key lookup stays well-formed.
  const linkKeyEnv = str("link_key_env");
  const validLinkKeyEnv = /^[A-Z][A-Z0-9_]{0,63}$/.test(linkKeyEnv);
  if (!validLinkKeyEnv) fallbacks.push("link_key_env");
  const out = {
    bucket: str("bucket"),
    link_ttl_days: posInt("link_ttl_days", 1, 365),
    signed_url_seconds: posInt("signed_url_seconds", 30, 3600),
    short_domain: str("short_domain"),
    send_kind: str("send_kind"),
    stuck_claim_after_seconds: posInt("stuck_claim_after_seconds", 60, 86400),
    stuck_claim_list_limit: posInt("stuck_claim_list_limit", 1, 10000),
    link_key_env: validLinkKeyEnv ? linkKeyEnv : defaults.link_key_env,
  };
  if (fallbacks.length > 0) warnFallback("global.json", `invalid delivery values for ${fallbacks.join(", ")}`);
  return out;
}

/** email: shallow merge, but retryable_error_names must be a non-empty string[] (a string would make
 *  `.includes` a substring match; a number would throw inside sendEmail's error path). */
export function loadEmailSection(raw: Record<string, unknown> | undefined): GlobalSettings["email"] {
  const merged = { ...DEFAULT_GLOBAL.email, ...(raw ?? {}) } as GlobalSettings["email"];
  const names = (raw ?? {}).retryable_error_names;
  if (names !== undefined && !(Array.isArray(names) && names.length > 0 && names.every((entry) => typeof entry === "string" && entry !== "" && entry === entry.trim()))) {
    warnFallback("global.json", "invalid email values for retryable_error_names");
    merged.retryable_error_names = DEFAULT_GLOBAL.email.retryable_error_names;
  }
  return merged;
}

export const GLOBAL: GlobalSettings = loadGlobal();

/** Expand a leading `~/` (or bare `~`) to $HOME; non-tilde paths pass through. */
export function expandHome(p: string, home: string): string {
  if (home && (p === "~" || p.startsWith("~/"))) return path.join(home, p.slice(1));
  return p;
}

/** True when the process runs on a production-shaped money path: NODE_ENV=production,
 *  ANY VERCEL_ENV value (Vercel previews get the same fail-closed guards), or an AWS
 *  Lambda runtime. Guards that protect money writes (distributed idempotency lock,
 *  durable manual-review DLQ) must demand their infrastructure whenever this returns
 *  true — fail CLOSED when ambiguous; only a bare local/test runtime (no signal at
 *  all) may keep the optional-infra behavior. */
export function isMoneyPath(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV !== undefined ||
    !!process.env.AWS_LAMBDA_FUNCTION_NAME
  );
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
  /**
   * Launch switch. A provider is fully defined and its code is kept; this flag decides whether it takes sales.
   * Missing or false = off (fail closed). Off providers keep their config and verifier, and the webhook route refuses them.
   */
  enabled?: boolean;
}

// Inline mirror of data/settings/providers.json "payments" section (fallback contract).
export const DEFAULT_PAYMENT_PROVIDERS: Record<string, PaymentProviderSetting> = {
  lemonsqueezy: {
    enabled: false,
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
    enabled: false,
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
    enabled: true,
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
    enabled: false,
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
  polar: {
    enabled: false,
    route: "polar",
    signature_header: "webhook-signature",
    signature_scheme: "standard-webhooks: HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${raw_body}`, base64; whsec_ secrets created on/after 2026-09-08 = base64-decoded, older = UTF-8 bytes of full string",
    sale_events: ["order.created", "order.paid"],
    refund_events: ["refund.created"],
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
      refund_sale_id: "data.order_id",
      refund_ts: "data.created_at",
      attribution_id: "data.metadata.reference_id",
    },
  },
  fungies: {
    // Off until the founder approves Fungies as a launch rail. Its verifier stays wired so it can be switched on.
    enabled: false,
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

/** Every provider in the inline defaults, switched off. Used when providers.json exists but cannot be used. */
export function allProvidersOff(): Record<string, PaymentProviderSetting> {
  return Object.fromEntries(Object.entries(DEFAULT_PAYMENT_PROVIDERS).map(([name, s]) => [name, { ...s, enabled: false }]));
}

/** Normalises a providers.json "payments" map. A missing or non-boolean `enabled` is OFF, with a warning, and a
 *  non-object entry is dropped. A provider absent from the file is not registered, so it is off too. */
export function parsePaymentProviders(payments: Record<string, unknown>): Record<string, PaymentProviderSetting> {
  const out: Record<string, PaymentProviderSetting> = {};
  for (const [name, value] of Object.entries(payments)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      console.error(`[settings-registry] providers.json '${name}' is not an object — dropped (off)`);
      continue;
    }
    const setting = value as PaymentProviderSetting;
    if (typeof setting.enabled !== "boolean") {
      console.error(`[settings-registry] providers.json '${name}.enabled' is missing or not a boolean — '${name}' is OFF (fail closed)`);
      out[name] = { ...setting, enabled: false };
    } else {
      out[name] = setting;
    }
  }
  return out;
}

function loadPaymentProviders(): Record<string, PaymentProviderSetting> {
  const read = readRegistryResult("providers.json");
  if (read.kind === "missing") {
    warnFallback("providers.json", "missing");
    return DEFAULT_PAYMENT_PROVIDERS;
  }
  if (read.kind === "invalid") {
    console.error("[settings-registry] providers.json exists but cannot be used — ALL providers OFF (fail closed)");
    return allProvidersOff();
  }
  const payments = read.data["payments"];
  if (!payments || typeof payments !== "object" || Array.isArray(payments)) {
    console.error("[settings-registry] providers.json has no usable 'payments' section — ALL providers OFF (fail closed)");
    return allProvidersOff();
  }
  return parsePaymentProviders(payments as Record<string, unknown>);
}

export const PAYMENT_PROVIDERS: Record<string, PaymentProviderSetting> = loadPaymentProviders();

export function paymentProviderSetting(name: string): PaymentProviderSetting | undefined {
  return PAYMENT_PROVIDERS[name];
}

/** True only for a provider that is defined AND switched on. Use this for anything that takes or routes a sale. */
export function isEnabledPaymentProvider(name: string): boolean {
  return isRegisteredPaymentProvider(name) && PAYMENT_PROVIDERS[name]?.enabled === true;
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
    if (part === "__proto__") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
