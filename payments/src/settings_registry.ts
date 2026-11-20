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

/** Paddle.js overlay checkout on pay.expanpress.com (the buyer email step opens it). The two *_env fields are the NAMES of
 *  environment variables, never values. The client token and the environment are read on the server with these names, because
 *  a NEXT_PUBLIC_* value is only inlined into the client bundle when it is referenced by its literal name. */
export interface PaddleOverlaySettings {
  client_token_env: string;
  environment_env: string;
  theme: "light" | "dark";
  locale: string;
  /** customData key carrying the attribution reference. The webhook reads it as the sale's attribution id. */
  order_ref_key: string;
  /** customData key carrying the buyer's consent ("true" or "false"). Buyer-supplied: recorded on the order, never a trust decision. */
  buyer_consent_key: string;
}

export interface PaymentRoutingSettings {
  mode: "single" | "distribute" | "cascade" | "2d";
  distribution: Array<{ provider: string; weight: number }>;
  fallbacks: string[];
}

export interface BrandCheckoutSettings {
  version: string;
  theme_mode: "light" | "dark";
  font_family: string;
  /** Font stack for transactional HTML email (buyer delivery). Email clients need system fonts, not web fonts. */
  email_font_stack: string;
  logo_url: string;
  logo_square_url: string;
  colors: {
    canvas: string;
    charcoal: string;
    peach: string;
    accent: string;
    button_primary: string;
    button_hover: string;
    button_text: string;
    border: string;
    /** Email card surface (white card on the canvas). */
    surface: string;
    /** Email secondary text (wordmark braces, body detail). */
    muted: string;
    /** Email footer text. */
    subtle: string;
  };
  button_border_radius_px: number;
}

export interface EmailRolesSettings {
  /** General customer support and creator portal assistance. */
  support: string;
  /** Refund requests, receipt questions, MoR dispute handling. */
  billing: string;
  /** GDPR, CCPA, DSAR, and statutory privacy requests. */
  privacy: string;
  /** Terms of service, DMCA, contract, and IP compliance. */
  legal: string;
  /** Outbound transactional sender display name and address. */
  sender: string;
  /** Alias kept in sync with `sender` for existing callers/tests. */
  from: string;
  reply_to: string;
  sending_domain: string;
  retryable_error_names: string[];
  /** Resend HTTP status for a concurrent request with the same idempotency key: the original may still be accepted, so the outcome is unconfirmed. */
  concurrent_request_status: number;
  /** Resend error name that goes with concurrent_request_status. */
  concurrent_request_error_name: string;
  /** Resend HTTP status for a definite refusal of the message itself (a validation error, in practice the buyer address).
   *  No retry can succeed, so the sale is answered 422 and quarantined, not retried. Config refusals (401, 403) stay retryable. */
  address_rejected_status: number;
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
    /** One overall deadline per webhook request, in ms, counted from the request start. The sale write is never cut short;
     *  the buyer lookup, the download link and the receipt send get only what is left. Past it, delivery answers 503
     *  (Retry-After) and the provider's retry resends the stored receipt under the same idempotency key. Paddle answers
     *  within 5 s, so the default is 3000 (2 s headroom for cold start and the response). Set in the registry, not in code. */
    webhook_total_budget_ms: number;
    sync_http_timeout_ms: number; // operator CLI (sync_book_identity) calls to Supabase/Paddle
    review_queue_page_size: number; // listManualReviewRefunds default page/limit
    /** Retry-After seconds sent on 503 webhook responses (in-flight AND generic 503 paths). */
    retry_after_seconds: number;
    paddle: { api_base: { production: string; sandbox: string }; js_cdn_url: string; overlay: PaddleOverlaySettings };
    routing: PaymentRoutingSettings;
    /** Creem TEST mode is accepted only when this is true, creem_test_database_ref is non-empty,
     *  AND new URL(SUPABASE_URL).hostname equals `${creem_test_database_ref}.supabase.co`.
     *  Production has no global.json, so this stays false there. Test-only; see creem.adapter.ts. */
    creem_accept_test_mode: boolean;
    /** Project ref of the separate test database (branch) that test-mode Creem events may write to. Empty = refuse. */
    creem_test_database_ref: string;
    /** Explicit opt-in for sandbox checkout acceptance (sandbox checkout_mode and sandbox.* rail hosts)
     *  on non-production runtimes. Default false (fail closed); production always refuses regardless. */
    sandbox_checkout_enabled: boolean;
    /** ISO 3166-1 alpha-2 buyer country codes permitted at checkout (launch: US + DC/territories). */
    allowed_buyer_countries: string[];
  };
  /** Buyer-facing storefront links, publisher name, card copy, and registry-driven asset paths. `b2c_landing_url` is the logo
   *  target on the thank-you page. `brand_name` is the publisher's name: a creator whose display name equals it is the house, and
   *  the page names it as publisher. `publisher_label` is not set separately; it always equals `brand_name` (one source).
   *  `thanks_path_template` is the thank-you page a checkout returns to ({handle} is replaced with the creator handle).
   *  `house_title_note` is the one-line note on a house title (creators.is_house): published by ExpanPress, no creator split. */
  storefront: {
    b2c_landing_url: string;
    brand_name: string;
    publisher_label: string;
    thanks_path_template: string;
    house_title_note: string;
    house_creator_bio: string;
    digital_pdf_kicker: string;
    sample_badge_label: string;
    show_non_live_samples: boolean;
    allowed_non_live_sample_modes: string[];
    coming_soon_badge: string;
    sample_preview_cta: string;
    browse_books_label: string;
    browse_books_path: string;
    /** `storefront.browse_books_enabled`: shows the "browse books" links on the B2B home (header top-right and hero card).
     *  Off by default because the links expose how few titles exist. Re-enable once several creators and house books
     *  are live. If re-enabled, the header top-right is the founder-approved placement. */
    browse_books_enabled: boolean;
    /** `storefront.hide_empty_creator_hubs`: a creator hub with no visible storefront product (per isVisibleStorefrontProduct)
     *  returns 404 Not Found instead of an empty shelf. The house hub (creators.is_house) is never 404'd by this rule.
     *  false restores the empty-shelf render. */
    hide_empty_creator_hubs: boolean;
    always_show_buyer_legal: boolean;
    /** Buyer legal links (label and path) shown in the storefront footer and on the pay root page. Fixed copy and paths. */
    buyer_legal_links: ReadonlyArray<{ label: string; path: string }>;
    pay_root_kicker: string;
    pay_root_heading: string;
    pay_root_description: string;
    covers_base_path: string;
    previews_base_path: string;
    book_assets: Record<
      string,
      { book_registry?: string; cover_image?: string | null; preview_pdf?: string | null; is_sample?: boolean }
    >;
    product_layout: StorefrontProductLayoutSettings;
  };
  /** Product-page PDF previewer tunables (PDF.js + StPageFlip). */
  book_preview: BookPreviewSettings;
  /** Creator handle policy (web/src/lib/handle-policy.ts). Set once at account creation; immutable after. */
  handles: { min_length: number; max_length: number; separator: string; reserved: string[]; profanity_whitelist: string[] };
  /** Product slug rule (ADR 0065): same shape as handles. Unique per creator (products_creator_id_slug_key);
   *  platform-wide products_slug_key was reverted and is dropped by supabase/migrations/20261117110000_products_slug_convergence.sql. */
product_slug: { min_length: number; max_length: number; separator: string };
  /** Sign-in email length ceiling (O5). 254 is the RFC 5321 address limit; zod's email check supplies the shape. */
  /** `typo_domains` is the list the buyer email step checks a typo against. A close miss is suggested, never applied silently. */
  email_address: { max_length: number; typo_domains: string[] };
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
    /** Age in seconds an operator's listStuckDeliveryClaims query uses by default. The webhook does not age-gate held claims: a held claim with no stored message is flagged at once. */
    stuck_claim_after_seconds: number;
    /** Most rows listStuckDeliveryClaims returns (oldest first). Bounds the operator reconcile query. */
    stuck_claim_list_limit: number;
    /** Look-back window (hours) for the operator's WEBHOOK_TERMINAL_REJECT listing in scripts/ops/stuck_report.ts. A reject older than the window drops off that report. */
    terminal_reject_lookback_hours: number;
    /** Most WEBHOOK_TERMINAL_REJECT rows stuck_report.ts lists (newest first). Bounds the operator read. */
    terminal_reject_list_limit: number;
    /** NAME of the env var holding the base64 32-byte AES-256-GCM key that encrypts a held claim's stored buyer email. */
    link_key_env: string;
    /** Key id written into each new encrypted claim message (envelope v2). A legacy v1 envelope is read as this id. */
    link_key_id: string;
    /** Origin of the buyer download link ({origin}/books/d/{token}). An https origin with no path. */
    download_origin: string;
    /**
     * When the stored-message change took effect (migration 20261118120000). A held claim created before this instant with no
     * stored message may have been sent without one, so it is flagged for manual reconciliation, never resent or re-minted.
     * A later value is the safe direction (more claims are flagged). Set it to the deploy time before deploying.
     */
    stored_message_since: string;
    /**
     * Oldest a held or unconfirmed claim may be and still resend its stored message under the same Resend idempotency key.
     * Resend keeps idempotency keys for 24 hours, so the loader caps this at 24: a later resend could be a second email.
     */
    stored_message_resend_max_age_hours: number;
    /** Buyer delivery promise shown in the consent line: the usual delay in minutes. */
    buyer_typical_minutes: number;
    /**
     * Buyer support promise shown in the consent line: after this many hours without the e-book, the buyer is asked to write to
     * the support address (email.reply_to), and support sends it by hand. Replaces the retired six-hour delivery promise.
     */
    buyer_support_after_hours: number;
    /** Checkout metadata key that carries the buyer's consent (true or false) on a provider whose checkout link documents metadata. */
    buyer_consent_metadata_key: string;
  };
  /** Transactional email & role routing (Resend). `sender`/`from` must be on `sending_domain` (DKIM-verified in Resend). */
  email: EmailRolesSettings;
  /** Versioned MoR checkout branding tokens (PROVIDER_CHECKOUT_BRANDING.md). */
  branding: BrandCheckoutSettings;
  portal: { jwt_clock_skew_retry_delay_ms: number };
  consent: { text_version: string; evidence_path: { user_id_pattern: string; envelope_id_pattern: string } };
  /** Daily usage watch (scripts/ops/usage_watch.ts). Limits are the plan limits we are on (Vercel Hobby, Supabase Free org,
   *  Upstash pay-as-you-go); warn_ratio is the fraction of a limit at which the watch reports WARN and exits non-zero. */
  usage_watch: UsageWatchSettings;
}

export interface StorefrontProductLayoutSettings {
  cover_max_width_px: number;
  cover_max_width_pct: number;
  gap_mobile_px: number;
  gap_desktop_px: number;
  preview_section_id: string;
  preview_cue_label: string;
  cue_bounce_distance_px: number;
  cue_bounce_duration_s: number;
  cue_bounce_repeat_delay_s: number;
}

export interface BookPreviewToolbarLabels {
  toolbar_aria_label: string;
  zoom_in: string;
  zoom_out: string;
  reset_zoom: string;
  go_to_page: string;
  go_to_page_submit: string;
  prev_page: string;
  next_page: string;
  navigation_aria_label: string;
  region_aria_label: string;
}

export interface BookPreviewReadAloudLabels {
  group_aria_label: string;
  play: string;
  pause: string;
  resume: string;
  stop: string;
  play_text: string;
  pause_text: string;
  resume_text: string;
  stop_text: string;
  speed_aria_label: string;
  rate_suffix: string;
  finished_announcement: string;
}

export interface BookPreviewReadAloudVoiceSettings {
  /** Book language as a BCP 47 tag. Voices in this language rank first, then any voice sharing its primary subtag. */
  lang: string;
  /** Quality markers in priority order. A voice whose name contains an earlier marker ranks higher. */
  quality_markers: ReadonlyArray<string>;
  /** Preferred gender order. A voice with no recognised gender ranks after every listed gender. */
  gender_order: ReadonlyArray<"female" | "male">;
  /** Name tokens that identify a voice's gender. Browser voices expose no gender field. */
  female_name_hints: ReadonlyArray<string>;
  male_name_hints: ReadonlyArray<string>;
}

export interface BookPreviewReadAloudSettings {
  enabled: boolean;
  rates: ReadonlyArray<number>;
  default_rate: number;
  max_chunk_chars: number;
  /** Also highlight the word being spoken. Needs boundary events; voices without them keep the sentence highlight only. */
  highlight_words: boolean;
  /** On a page turn during playback, continue from the top of the newly visible page (true) or stop (false). */
  continue_on_page_turn: boolean;
  voice: BookPreviewReadAloudVoiceSettings;
  labels: BookPreviewReadAloudLabels;
}

export interface BookPreviewTextStructureSettings {
  line_y_tolerance: number;
  heading_scale_ratio: number;
  major_heading_scale_ratio: number;
  paragraph_gap_ratio: number;
  max_heading_chars: number;
  toggle_single: string;
  toggle_plural: string;
  page_label_prefix: string;
}

export interface BookPreviewSettings {
  pdf_worker_src: string;
  render_scale: number;
  max_preview_pages: number;
  page_width_px: number;
  page_height_px: number;
  min_width_px: number;
  max_width_px: number;
  min_height_px: number;
  max_height_px: number;
  flipping_time_ms: number;
  max_shadow_opacity: number;
  swipe_distance_px: number;
  /** Distance (px) outside the viewport at which the preview starts loading and stops when it is further away.
   *  The page-flip loop redraws every animation frame while mounted, so the book is mounted only near the viewport. */
  visibility_margin_px: number;
  show_cover: boolean;
  use_portrait: boolean;
  heading: string;
  subheading: string;
  /** Ordered zoom multipliers starting at 1 (default 100%, then 2 zoom-in levels). */
  zoom_levels: ReadonlyArray<number>;
  toolbar_labels: BookPreviewToolbarLabels;
  read_aloud: BookPreviewReadAloudSettings;
  text_structure: BookPreviewTextStructureSettings;
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

/** The publisher name, one literal. storefront.brand_name and storefront.publisher_label both read it. */
const STOREFRONT_BRAND = "ExpanPress";

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
    webhook_total_budget_ms: 3000,
    sync_http_timeout_ms: 30000,
    review_queue_page_size: 200,
    retry_after_seconds: 30,
    creem_accept_test_mode: false,
    creem_test_database_ref: "",
    sandbox_checkout_enabled: false,
    allowed_buyer_countries: ["US", "PR", "VI", "GU", "AS", "MP"],
    paddle: {
      api_base: { production: "https://api.paddle.com", sandbox: "https://sandbox-api.paddle.com" },
      js_cdn_url: "https://cdn.paddle.com/paddle/v2/paddle.js",
      overlay: {
        client_token_env: "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN",
        environment_env: "NEXT_PUBLIC_PADDLE_ENVIRONMENT",
        theme: "light",
        locale: "en",
        order_ref_key: "order_ref",
        buyer_consent_key: "buyer_consent",
      },
    },
    routing: {
      mode: "2d",
      distribution: [{ provider: "paddle", weight: 100 }],
      fallbacks: ["lemonsqueezy", "fastspring"],
    },
  },
  // Home target for every buyer-side logo and home link (thank-you page, checkout). Absolute, so a buyer on
  // pay.expanpress.com also lands on the B2C landing, never on the B2B root. The B2C landing is /books on the main site.
  storefront: {
    b2c_landing_url: "https://expanpress.com/books",
    brand_name: STOREFRONT_BRAND,
    publisher_label: STOREFRONT_BRAND,
    thanks_path_template: "/books/{handle}/thanks",
    house_title_note: `House title. Published by ${STOREFRONT_BRAND}. No creator revenue split.`,
    // founder-approved 2026-11-20 (option A, may revisit before KYC)
    house_creator_bio: `${STOREFRONT_BRAND} is a done-for-you e-book publisher for creators in every field. Each book is built from the creator's own work, voice and experience. The titles on this page are published by ${STOREFRONT_BRAND} under its own name.`,
    digital_pdf_kicker: "DIGITAL PDF",
    sample_badge_label: "(Sample)",
    show_non_live_samples: true,
    allowed_non_live_sample_modes: ["gated"],
    coming_soon_badge: "Coming soon",
    sample_preview_cta: "Preview sample",
    browse_books_label: "Browse books",
    browse_books_path: "/books",
    browse_books_enabled: false,
    hide_empty_creator_hubs: true,
    always_show_buyer_legal: true,
    buyer_legal_links: [
      { label: "Privacy Policy", path: "/books/legal/privacy.html" },
      { label: "Terms of Sale", path: "/books/legal/terms.html" },
      { label: "Refund Policy", path: "/books/legal/refund-policy.html" },
    ],
    pay_root_kicker: "Secure checkout",
    pay_root_heading: "Digital book checkout",
    pay_root_description: "Secure digital book checkout. Browse published titles or review buyer legal policies below.",
    covers_base_path: "/books/covers",
    previews_base_path: "/books/previews",
    book_assets: {
      "500k_playbook": { book_registry: "books/duane.json" },
      sample_the_quiet_workshop: { book_registry: "books/sample_the_quiet_workshop.json" },
    },
    product_layout: {
      cover_max_width_px: 384,
      cover_max_width_pct: 36,
      gap_mobile_px: 24,
      gap_desktop_px: 56,
      preview_section_id: "book-preview",
      preview_cue_label: "Have a look inside",
      cue_bounce_distance_px: 5,
      cue_bounce_duration_s: 1.8,
      cue_bounce_repeat_delay_s: 0.4,
    },
  },
  book_preview: {
    pdf_worker_src: "/pdfjs/pdf.worker.min.mjs",
    render_scale: 2,
    max_preview_pages: 16,
    page_width_px: 400,
    page_height_px: 600,
    min_width_px: 260,
    max_width_px: 460,
    min_height_px: 390,
    max_height_px: 690,
    flipping_time_ms: 600,
    max_shadow_opacity: 0.25,
    swipe_distance_px: 30,
    visibility_margin_px: 200,
    show_cover: true,
    use_portrait: true,
    heading: "Preview inside the book",
    subheading: "Turn pages to inspect the cover, Chapter 1, an interior chapter opener, and back cover.",
    zoom_levels: [1, 1.35, 1.75],
    toolbar_labels: {
      toolbar_aria_label: "Preview controls",
      zoom_in: "Zoom in",
      zoom_out: "Zoom out",
      reset_zoom: "Reset zoom",
      go_to_page: "Go to page",
      go_to_page_submit: "Go",
      prev_page: "Previous preview page",
      next_page: "Next preview page",
      navigation_aria_label: "Preview navigation for {title}",
      region_aria_label: "Interactive page-turning preview of {title}. Use Left and Right arrow keys or Prev and Next buttons to turn pages.",
    },
    read_aloud: {
      enabled: true,
      rates: [0.75, 1, 1.25, 1.5],
      default_rate: 1,
      max_chunk_chars: 180,
      highlight_words: false,
      continue_on_page_turn: true,
      voice: {
        lang: "en-US",
        // Edge neural ("Online (Natural)"), Chrome network ("Google"), Apple ("Enhanced"/"Premium"/"Siri"), then legacy SAPI.
        quality_markers: ["Online (Natural)", "Natural", "Google", "Neural", "Enhanced", "Premium", "Siri"],
        gender_order: ["female", "male"],
        female_name_hints: ["Aria", "Jenny", "Zira", "Ava", "Allison", "Susan", "Karen", "Samantha", "Victoria", "Female"],
        male_name_hints: ["David", "Mark", "Guy", "Daniel", "Alex", "Fred", "Tom", "Male"],
      },
      labels: {
        group_aria_label: "Read aloud controls",
        play: "Read aloud: preview text",
        pause: "Pause reading aloud",
        resume: "Resume reading aloud",
        stop: "Stop reading aloud",
        play_text: "Read aloud",
        pause_text: "Pause",
        resume_text: "Resume",
        stop_text: "Stop",
        speed_aria_label: "Reading speed",
        rate_suffix: "×",
        finished_announcement: "Finished reading preview pages.",
      },
    },
    text_structure: {
      line_y_tolerance: 2,
      heading_scale_ratio: 1.2,
      major_heading_scale_ratio: 1.45,
      paragraph_gap_ratio: 1.7,
      max_heading_chars: 120,
      toggle_single: "Accessible text for visible preview page",
      toggle_plural: "Accessible text for visible preview pages",
      page_label_prefix: "Page",
    },
  },
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
  email_address: {
    max_length: 254,
    // US consumer mail domains (the plan is US sales only). Used by the buyer email typo check.
    typo_domains: [
      "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
      "icloud.com", "me.com", "aol.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "protonmail.com", "proton.me",
    ],
  },
  landing: {
    fallbacks: { title: "Product", creator: "the creator" },
    disclaimers: [
      "Educational and informational content only. Nothing in these publications is professional advice of any kind, including financial, legal, medical, or tax advice. See each publication's page for its full disclaimer.",
      "Digital products: all items are downloadable PDFs; no physical items are shipped.",
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
    // Display window for the stuck_report terminal-reject section (30 days), not an acknowledgement: nothing marks a reject
    // as reconciled. A reject older than this is no longer listed, but stuck_report still exits 1 while one exists.
    terminal_reject_lookback_hours: 720,
    // Rows stuck_report lists. Reaching this cap prints an explicit line and the report exits 1. Validated at most 1000
    // (Supabase's default max rows): a larger limit would be truncated server-side, and the cap could then not be detected.
    terminal_reject_list_limit: 200,
    // Only the env var NAME is a setting; the key value never lives in the registry or the repo.
    link_key_env: "DELIVERY_LINK_KEY",
    // Key id for new encrypted claim messages. Bump it together with the key in link_key_env when the key is rotated.
    link_key_id: "k1",
    download_origin: "https://expanpress.com",
    // Cutover timestamp for migration 20261118120000_delivery_claim_link.sql.
    // NOTE: CCT must stamp the exact UTC deploy time at merge/deploy so pre-deploy held claims cannot be misclassified as post-cutover and resent twice.
    stored_message_since: "2026-11-19T05:00:00Z",
    // Resend keeps idempotency keys for 24 hours (email.ts). A shorter window only resends less often.
    stored_message_resend_max_age_hours: 24,
    // The buyer consent line promises a usual delay of 2 minutes, and a support route after 1 hour without the e-book.
    buyer_typical_minutes: 2,
    buyer_support_after_hours: 1,
    buyer_consent_metadata_key: "buyer_email_consent",
  },
  email: {
    support: "support@expanpress.com",
    billing: "billing@expanpress.com",
    privacy: "privacy@expanpress.com",
    legal: "legal@expanpress.com",
    sender: "ExpanPress <delivery@expanpress.com>",
    from: "ExpanPress <delivery@expanpress.com>",
    reply_to: "support@expanpress.com", // has MX (registrar forwarding); the esign/ops subdomains do not
    sending_domain: "expanpress.com",
    retryable_error_names: [
      "rate_limit_exceeded",
      "application_error",
      "internal_server_error",
      "daily_quota_exceeded",
    ],
    concurrent_request_status: 409,
    concurrent_request_error_name: "concurrent_idempotent_requests",
    address_rejected_status: 422,
  },
  branding: {
    version: "2026-11-v1",
    theme_mode: "light",
    font_family: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    email_font_stack: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    logo_url: "https://expanpress.com/assets/expanpress-logo.svg",
    logo_square_url: "https://expanpress.com/assets/expanpress-logo.webp",
    colors: {
      canvas: "#F9F6F0",
      charcoal: "#181818",
      peach: "#FF9E80",
      accent: "#E8622C",
      button_primary: "#2A2A2A",
      button_hover: "#383838",
      button_text: "#FFFFFF",
      border: "#dcc7b4",
      surface: "#FFFFFF",
      muted: "#4b5563",
      subtle: "#6b7280",
    },
    button_border_radius_px: 24,
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
  // Paddle needs an answer within 5 s; the max leaves 500 ms headroom. The default is 3000 (see GlobalSettings).
  webhook_total_budget_ms: { min: 1000, max: 4500 },
  sync_http_timeout_ms: { min: 1000, max: 120000 },
  review_queue_page_size: { min: 1, max: 1000 },
  retry_after_seconds: { min: 1, max: 600 },
} as const;

function intInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

// Accepts only the exact canonical Paddle host after stripping trailing slashes.
// Rejects credentials, non-default port, any path/query/fragment — Bearer tokens
// must never be sent to another host.
function isCanonicalPaddleApiUrl(value: unknown, expected: string): value is string {
  if (typeof value !== "string") return false;
  const s = value.replace(/\/+$/, "");
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

function isPaddleJsCdnUrl(value: unknown): value is string {
  return value === "https://cdn.paddle.com/paddle/v2/paddle.js";
}

// ISO 4217 codes our providers settle. Membership is explicit — shape checks
// ( /^[A-Z]{3}$/ ) accept nonsense like "ZZZ".
export const SUPPORTED_ISO_4217: ReadonlySet<string> = new Set([
  "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK",
  "PLN", "CZK", "HUF", "JPY", "SGD", "HKD", "INR", "BRL", "MXN", "ZAR",
  "AED", "SAR", "EGP", "TRY", "KRW", "CNY", "ILS", "ARS", "COP", "CLP",
  "PHP", "THB", "TWD", "UAH", "RUB",
] as const);

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** paddle.overlay: each value is checked against its own shape. An invalid value falls back to its default and is reported. */
function loadPaddleOverlay(raw: Record<string, unknown> | undefined, fallbacks: string[]): PaddleOverlaySettings {
  const defaults = DEFAULT_GLOBAL.payments.paddle.overlay;
  if (!raw) return defaults;
  const pick = <K extends keyof PaddleOverlaySettings>(key: K, valid: (v: unknown) => boolean): PaddleOverlaySettings[K] => {
    if (!(key in raw)) return defaults[key];
    const candidate = raw[key];
    if (valid(candidate)) return candidate as PaddleOverlaySettings[K];
    fallbacks.push(`paddle.overlay.${key}`);
    return defaults[key];
  };
  const envName = (v: unknown): boolean => typeof v === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(v);
  const keyName = (v: unknown): boolean => typeof v === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(v);
  return {
    client_token_env: pick("client_token_env", envName),
    environment_env: pick("environment_env", envName),
    theme: pick("theme", (v) => v === "light" || v === "dark"),
    locale: pick("locale", (v) => typeof v === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(v)),
    order_ref_key: pick("order_ref_key", keyName),
    buyer_consent_key: pick("buyer_consent_key", keyName),
  };
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
  const webhookTotalBudget = num("webhook_total_budget_ms");
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
  const overlay = loadPaddleOverlay(paddle.overlay as Record<string, unknown> | undefined, fallbacks);
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
  let allowedBuyerCountries = defaults.allowed_buyer_countries;
  if (p.allowed_buyer_countries !== undefined) {
    const list = Array.isArray(p.allowed_buyer_countries)
      ? p.allowed_buyer_countries.map((c) => String(c).trim().toUpperCase())
      : null;
    if (list && list.length > 0 && list.every((c) => /^[A-Z]{2}$/.test(c))) {
      allowedBuyerCountries = list;
    } else {
      fallbacks.push("allowed_buyer_countries");
    }
  }
  let routing = defaults.routing;
  if (p.routing !== undefined) {
    const rawRouting = p.routing as unknown as Record<string, unknown> | null;
    const modes = new Set(["single", "distribute", "cascade", "2d"]);
    const modeOk =
      rawRouting &&
      typeof rawRouting === "object" &&
      !Array.isArray(rawRouting) &&
      typeof rawRouting.mode === "string" &&
      modes.has(rawRouting.mode);
    const distOk =
      rawRouting &&
      Array.isArray(rawRouting.distribution) &&
      rawRouting.distribution.length > 0 &&
      rawRouting.distribution.every(
        (distItem) =>
          distItem &&
          typeof distItem === "object" &&
          typeof (distItem as { provider?: unknown }).provider === "string" &&
          (distItem as { provider: string }).provider.trim() !== "" &&
          typeof (distItem as { weight?: unknown }).weight === "number" &&
          Number.isFinite((distItem as { weight: number }).weight) &&
          (distItem as { weight: number }).weight >= 0,
      );
    const fbOk =
      rawRouting &&
      Array.isArray(rawRouting.fallbacks) &&
      rawRouting.fallbacks.every((fbItem) => typeof fbItem === "string" && fbItem.trim() !== "");
    if (modeOk && distOk && fbOk) {
      routing = {
        mode: rawRouting.mode as PaymentRoutingSettings["mode"],
        distribution: (rawRouting.distribution as Array<{ provider: string; weight: number }>).map((distItem) => ({
          provider: distItem.provider.trim(),
          weight: distItem.weight,
        })),
        fallbacks: (rawRouting.fallbacks as string[]).map((fbItem) => fbItem.trim()),
      };
    } else {
      fallbacks.push("routing");
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
    webhook_total_budget_ms: webhookTotalBudget,
    sync_http_timeout_ms: syncHttpTimeout,
    review_queue_page_size: reviewQueuePageSize,
    retry_after_seconds: retryAfterSeconds,
    paddle: { api_base: { production: apiProduction, sandbox: apiSandbox }, js_cdn_url: jsCdn, overlay },
    routing,
    creem_accept_test_mode: p.creem_accept_test_mode === true,
    creem_test_database_ref: typeof p.creem_test_database_ref === "string" ? p.creem_test_database_ref.trim() : "",
    sandbox_checkout_enabled: sandboxCheckoutEnabled,
    allowed_buyer_countries: allowedBuyerCountries,
  };
}

export const STOREFRONT_PRODUCT_LAYOUT_LIMITS = {
  cover_max_width_px: { min: 240, max: 600 },
  cover_max_width_pct: { min: 25, max: 50 },
  gap_mobile_px: { min: 8, max: 64 },
  gap_desktop_px: { min: 40, max: 72 },
  cue_bounce_distance_px: { min: 1, max: 16 },
  cue_bounce_duration_s: { min: 0.4, max: 5 },
  cue_bounce_repeat_delay_s: { min: 0, max: 5 },
} as const;

function loadStorefrontProductLayout(
  raw: unknown,
  fallbacks: string[],
): StorefrontProductLayoutSettings {
  const defaults = DEFAULT_GLOBAL.storefront.product_layout;
  if (raw === undefined) return defaults;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fallbacks.push("product_layout");
    return defaults;
  }
  const layoutRaw = raw as Record<string, unknown>;
  const intField = (
    key: "cover_max_width_px" | "cover_max_width_pct" | "gap_mobile_px" | "gap_desktop_px" | "cue_bounce_distance_px",
  ): number => {
    if (!(key in layoutRaw)) return defaults[key];
    const { min, max } = STOREFRONT_PRODUCT_LAYOUT_LIMITS[key];
    if (intInRange(layoutRaw[key], min, max)) return layoutRaw[key];
    fallbacks.push(`product_layout.${key}`);
    return defaults[key];
  };
  const floatField = (key: "cue_bounce_duration_s" | "cue_bounce_repeat_delay_s"): number => {
    if (!(key in layoutRaw)) return defaults[key];
    const candidate = layoutRaw[key];
    const { min, max } = STOREFRONT_PRODUCT_LAYOUT_LIMITS[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= min && candidate <= max) return candidate;
    fallbacks.push(`product_layout.${key}`);
    return defaults[key];
  };
  let previewSectionId = defaults.preview_section_id;
  if ("preview_section_id" in layoutRaw) {
    if (typeof layoutRaw.preview_section_id === "string" && /^[a-z][a-z0-9_-]{1,63}$/.test(layoutRaw.preview_section_id)) {
      previewSectionId = layoutRaw.preview_section_id;
    } else {
      fallbacks.push("product_layout.preview_section_id");
    }
  }
  let previewCueLabel = defaults.preview_cue_label;
  if ("preview_cue_label" in layoutRaw) {
    if (typeof layoutRaw.preview_cue_label === "string" && layoutRaw.preview_cue_label.trim() !== "") {
      previewCueLabel = layoutRaw.preview_cue_label.trim();
    } else {
      fallbacks.push("product_layout.preview_cue_label");
    }
  }
  return {
    cover_max_width_px: intField("cover_max_width_px"),
    cover_max_width_pct: intField("cover_max_width_pct"),
    gap_mobile_px: intField("gap_mobile_px"),
    gap_desktop_px: intField("gap_desktop_px"),
    preview_section_id: previewSectionId,
    preview_cue_label: previewCueLabel,
    cue_bounce_distance_px: intField("cue_bounce_distance_px"),
    cue_bounce_duration_s: floatField("cue_bounce_duration_s"),
    cue_bounce_repeat_delay_s: floatField("cue_bounce_repeat_delay_s"),
  };
}

/** storefront: validates b2c_landing_url, brand_name, thanks_path_template, house_title_note, card copy, sample listing flags,
 *  asset paths, and product_layout; falls back per key on invalid input. publisher_label is derived from brand_name (one source). */
export function loadStorefrontSection(raw: Record<string, unknown> | undefined): GlobalSettings["storefront"] {
  const defaults = DEFAULT_GLOBAL.storefront;
  if (!raw) return defaults;
  const fallbacks: string[] = [];
  const strField = (
    key:
      | "digital_pdf_kicker"
      | "sample_badge_label"
      | "house_title_note"
      | "house_creator_bio"
      | "coming_soon_badge"
      | "sample_preview_cta"
      | "browse_books_label"
      | "pay_root_kicker"
      | "pay_root_heading"
      | "pay_root_description",
  ): string => {
    if (raw[key] === undefined) return defaults[key];
    const v = raw[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    fallbacks.push(key);
    return defaults[key];
  };
  let browseBooksPath = defaults.browse_books_path;
  if ("browse_books_path" in raw) {
    if (raw.browse_books_path === "/books" || isSafeBooksPrefix(raw.browse_books_path)) {
      browseBooksPath = raw.browse_books_path;
    } else {
      fallbacks.push("browse_books_path");
    }
  }
  let browseBooksEnabled = defaults.browse_books_enabled;
  if ("browse_books_enabled" in raw) {
    if (typeof raw.browse_books_enabled === "boolean") browseBooksEnabled = raw.browse_books_enabled;
    else fallbacks.push("browse_books_enabled");
  }
  let hideEmptyCreatorHubs = defaults.hide_empty_creator_hubs;
  if ("hide_empty_creator_hubs" in raw) {
    if (typeof raw.hide_empty_creator_hubs === "boolean") hideEmptyCreatorHubs = raw.hide_empty_creator_hubs;
    else fallbacks.push("hide_empty_creator_hubs");
  }
  let alwaysShowBuyerLegal = defaults.always_show_buyer_legal;
  if ("always_show_buyer_legal" in raw) {
    if (typeof raw.always_show_buyer_legal === "boolean") alwaysShowBuyerLegal = raw.always_show_buyer_legal;
    else fallbacks.push("always_show_buyer_legal");
  }
  let showNonLiveSamples = defaults.show_non_live_samples;
  if ("show_non_live_samples" in raw) {
    if (typeof raw.show_non_live_samples === "boolean") showNonLiveSamples = raw.show_non_live_samples;
    else fallbacks.push("show_non_live_samples");
  }
  const NON_LIVE_MODES = new Set(["gated", "sandbox", "paddle"]);
  let allowedNonLiveSampleModes = defaults.allowed_non_live_sample_modes;
  if ("allowed_non_live_sample_modes" in raw) {
    const rawModes = raw.allowed_non_live_sample_modes;
    if (
      Array.isArray(rawModes) &&
      rawModes.every((m) => typeof m === "string" && NON_LIVE_MODES.has(m.trim()))
    ) {
      allowedNonLiveSampleModes = Array.from(new Set(rawModes.map((m) => m.trim())));
    } else {
      fallbacks.push("allowed_non_live_sample_modes");
    }
  }
  const b2cLanding = isHttpsUrl(raw.b2c_landing_url) ? raw.b2c_landing_url : defaults.b2c_landing_url;
  if (raw.b2c_landing_url !== undefined && !isHttpsUrl(raw.b2c_landing_url)) fallbacks.push("b2c_landing_url");
  const brandName =
    typeof raw.brand_name === "string" && raw.brand_name.trim() !== ""
      ? raw.brand_name.trim()
      : defaults.brand_name;
  if (raw.brand_name !== undefined && !(typeof raw.brand_name === "string" && raw.brand_name.trim() !== "")) {
    fallbacks.push("brand_name");
  }
  const tplOk =
    typeof raw.thanks_path_template === "string" &&
    raw.thanks_path_template.startsWith("/") &&
    raw.thanks_path_template.includes("{handle}");
  const thanksTpl = tplOk ? (raw.thanks_path_template as string) : defaults.thanks_path_template;
  if (raw.thanks_path_template !== undefined && !tplOk) fallbacks.push("thanks_path_template");
  let coversBasePath = defaults.covers_base_path;
  if ("covers_base_path" in raw) {
    if (isSafeBooksPrefix(raw.covers_base_path)) coversBasePath = raw.covers_base_path;
    else fallbacks.push("covers_base_path");
  }
  let previewsBasePath = defaults.previews_base_path;
  if ("previews_base_path" in raw) {
    if (isSafeBooksPrefix(raw.previews_base_path)) previewsBasePath = raw.previews_base_path;
    else fallbacks.push("previews_base_path");
  }
  let bookAssets = defaults.book_assets;
  if ("book_assets" in raw) {
    if (raw.book_assets && typeof raw.book_assets === "object" && !Array.isArray(raw.book_assets)) {
      const merged: GlobalSettings["storefront"]["book_assets"] = { ...defaults.book_assets };
      for (const [slug, entry] of Object.entries(raw.book_assets as Record<string, unknown>)) {
        if (!/^[a-z0-9_]+$/.test(slug) || !entry || typeof entry !== "object" || Array.isArray(entry)) {
          fallbacks.push(`book_assets.${slug}`);
          continue;
        }
        const e = entry as Record<string, unknown>;
        merged[slug] = {
          ...(typeof e.book_registry === "string" ? { book_registry: e.book_registry } : {}),
          ...(e.cover_image === null || typeof e.cover_image === "string" ? { cover_image: e.cover_image } : {}),
          ...(e.preview_pdf === null || typeof e.preview_pdf === "string" ? { preview_pdf: e.preview_pdf } : {}),
          ...(typeof e.is_sample === "boolean" ? { is_sample: e.is_sample } : {}),
        };
      }
      bookAssets = merged;
    } else {
      fallbacks.push("book_assets");
    }
  }
  const houseNote = strField("house_title_note");
  const productLayout = loadStorefrontProductLayout(raw.product_layout, fallbacks);
  if (fallbacks.length > 0) warnFallback("global.json", `invalid storefront values for ${fallbacks.join(", ")}`);
  return {
    b2c_landing_url: b2cLanding,
    brand_name: brandName,
    publisher_label: brandName,
    thanks_path_template: thanksTpl,
    house_title_note: houseNote,
    house_creator_bio: strField("house_creator_bio"),
    digital_pdf_kicker: strField("digital_pdf_kicker"),
    sample_badge_label: strField("sample_badge_label"),
    show_non_live_samples: showNonLiveSamples,
    allowed_non_live_sample_modes: allowedNonLiveSampleModes,
    coming_soon_badge: strField("coming_soon_badge"),
    sample_preview_cta: strField("sample_preview_cta"),
    browse_books_label: strField("browse_books_label"),
    browse_books_path: browseBooksPath,
    browse_books_enabled: browseBooksEnabled,
    hide_empty_creator_hubs: hideEmptyCreatorHubs,
    always_show_buyer_legal: alwaysShowBuyerLegal,
    // Fixed legal set (reviewed copy): not overridable from global.json, so the wording cannot drift from the defaults.
    buyer_legal_links: defaults.buyer_legal_links,
    pay_root_kicker: strField("pay_root_kicker"),
    pay_root_heading: strField("pay_root_heading"),
    pay_root_description: strField("pay_root_description"),
    covers_base_path: coversBasePath,
    previews_base_path: previewsBasePath,
    book_assets: bookAssets,
    product_layout: productLayout,
  };
}

/** branding: validates version, theme_mode, font_family, logo URLs, hex colours, and button radius. */
export function loadBrandingSection(raw: Record<string, unknown> | undefined): BrandCheckoutSettings {
  const defaults = DEFAULT_GLOBAL.branding;
  if (!raw) return defaults;
  const fallbacks: string[] = [];
  const str = (value: unknown, fallback: string, key: string): string => {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (value !== undefined) fallbacks.push(key);
    return fallback;
  };
  const httpsVal = (value: unknown, fallback: string, key: string): string => {
    if (isHttpsUrl(value)) return value;
    if (value !== undefined) fallbacks.push(key);
    return fallback;
  };
  const isHex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim());
  const rawColors = (raw.colors && typeof raw.colors === "object" && !Array.isArray(raw.colors)
    ? raw.colors
    : {}) as Record<string, unknown>;
  const hex = (key: keyof BrandCheckoutSettings["colors"]): string => {
    const candidate = rawColors[key];
    if (isHex(candidate)) return candidate.trim();
    if (candidate !== undefined) fallbacks.push(`colors.${key}`);
    return defaults.colors[key];
  };
  const themeMode =
    raw.theme_mode === "light" || raw.theme_mode === "dark"
      ? raw.theme_mode
      : (raw.theme_mode !== undefined && fallbacks.push("theme_mode"), defaults.theme_mode);
  const radius =
    intInRange(raw.button_border_radius_px, 0, 100)
      ? raw.button_border_radius_px
      : (raw.button_border_radius_px !== undefined && fallbacks.push("button_border_radius_px"), defaults.button_border_radius_px);
  if (fallbacks.length > 0) warnFallback("global.json", `invalid branding values for ${fallbacks.join(", ")}`);
  return {
    version: str(raw.version, defaults.version, "version"),
    theme_mode: themeMode,
    font_family: str(raw.font_family, defaults.font_family, "font_family"),
    email_font_stack: str(raw.email_font_stack, defaults.email_font_stack, "email_font_stack"),
    logo_url: httpsVal(raw.logo_url, defaults.logo_url, "logo_url"),
    logo_square_url: httpsVal(raw.logo_square_url, defaults.logo_square_url, "logo_square_url"),
    colors: {
      canvas: hex("canvas"),
      charcoal: hex("charcoal"),
      peach: hex("peach"),
      accent: hex("accent"),
      button_primary: hex("button_primary"),
      button_hover: hex("button_hover"),
      button_text: hex("button_text"),
      border: hex("border"),
      surface: hex("surface"),
      muted: hex("muted"),
      subtle: hex("subtle"),
    },
    button_border_radius_px: radius,
  };
}

function loadGlobal(): GlobalSettings {
  const raw = readRegistryFile("global.json");
  if (!raw) {
    warnFallback("global.json", "missing/unreadable");
    // Production deploys no global.json: env overrides (ADMIN_USER_IDS) must still apply.
    return {
      ...DEFAULT_GLOBAL,
      payments: loadPaymentsSection(undefined),
      branding: loadBrandingSection(undefined),
      admin: loadAdminSection(undefined),
    };
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
    storefront: loadStorefrontSection(g.storefront as Record<string, unknown> | undefined),
    book_preview: loadBookPreviewSection(g.book_preview as Record<string, unknown> | undefined),
    handles: { ...DEFAULT_GLOBAL.handles, ...(g.handles ?? {}) },
    product_slug: { ...DEFAULT_GLOBAL.product_slug, ...(g.product_slug ?? {}) },
    email_address: loadEmailAddressSection(g.email_address as Record<string, unknown> | undefined),
    email: loadEmailSection(g.email as Record<string, unknown> | undefined),
    branding: loadBrandingSection(g.branding as Record<string, unknown> | undefined),
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
  const str = (
    key:
      | "bucket"
      | "short_domain"
      | "send_kind"
      | "link_key_env"
      | "link_key_id"
      | "download_origin"
      | "stored_message_since"
      | "buyer_consent_metadata_key",
  ): string => {
    if (!(key in record)) return defaults[key];
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim() !== "" && candidate === candidate.trim()) return candidate;
    fallbacks.push(key);
    return defaults[key];
  };
  const posInt = (
    key:
      | "link_ttl_days"
      | "signed_url_seconds"
      | "stuck_claim_after_seconds"
      | "stuck_claim_list_limit"
      | "stored_message_resend_max_age_hours"
      | "buyer_typical_minutes"
      | "buyer_support_after_hours"
      | "terminal_reject_lookback_hours"
      | "terminal_reject_list_limit",
    min: number,
    max: number,
  ): number => {
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
  // A key id travels inside the ciphertext envelope, which separates fields with ":", so it is restricted to a safe charset.
  const linkKeyId = str("link_key_id");
  const validLinkKeyId = /^[A-Za-z0-9-]{1,32}$/.test(linkKeyId);
  if (!validLinkKeyId) fallbacks.push("link_key_id");
  // The buyer link origin: https, host only. Anything else falls back to the default (and warns).
  const downloadOrigin = str("download_origin");
  const validDownloadOrigin = /^https:\/\/[a-z0-9.-]+$/i.test(downloadOrigin);
  if (!validDownloadOrigin) fallbacks.push("download_origin");
  const storedSince = str("stored_message_since");
  const validStoredSince = Number.isFinite(Date.parse(storedSince));
  if (!validStoredSince) fallbacks.push("stored_message_since");
  const out = {
    bucket: str("bucket"),
    link_ttl_days: posInt("link_ttl_days", 1, 365),
    signed_url_seconds: posInt("signed_url_seconds", 30, 3600),
    short_domain: str("short_domain"),
    send_kind: str("send_kind"),
    stuck_claim_after_seconds: posInt("stuck_claim_after_seconds", 60, 86400),
    stuck_claim_list_limit: posInt("stuck_claim_list_limit", 1, 10000),
    terminal_reject_lookback_hours: posInt("terminal_reject_lookback_hours", 1, 8760),
    terminal_reject_list_limit: posInt("terminal_reject_list_limit", 1, 1000),
    link_key_env: validLinkKeyEnv ? linkKeyEnv : defaults.link_key_env,
    link_key_id: validLinkKeyId ? linkKeyId : defaults.link_key_id,
    download_origin: validDownloadOrigin ? downloadOrigin : defaults.download_origin,
    stored_message_since: validStoredSince ? storedSince : defaults.stored_message_since,
    stored_message_resend_max_age_hours: posInt("stored_message_resend_max_age_hours", 1, 24),
    buyer_typical_minutes: posInt("buyer_typical_minutes", 1, 60),
    buyer_support_after_hours: posInt("buyer_support_after_hours", 1, 24),
    // A metadata key name, not a value: the charset keeps it a plain key in a checkout link query. Invalid falls back.
    buyer_consent_metadata_key: /^[a-z][a-z0-9_]{0,63}$/.test(str("buyer_consent_metadata_key"))
      ? str("buyer_consent_metadata_key")
      : defaults.buyer_consent_metadata_key,
  };
  if (fallbacks.length > 0) warnFallback("global.json", `invalid delivery values for ${fallbacks.join(", ")}`);
  return out;
}

/** email_address: shallow merge, but typo_domains must be a non-empty list of hostnames (else the default, with a warning). */
function loadEmailAddressSection(raw: Record<string, unknown> | undefined): GlobalSettings["email_address"] {
  const base = DEFAULT_GLOBAL.email_address;
  if (!raw) return base;
  const domains = raw.typo_domains;
  const valid =
    Array.isArray(domains) &&
    domains.length > 0 &&
    domains.every((d) => typeof d === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
  if (raw.typo_domains !== undefined && !valid) warnFallback("global.json", "invalid email_address values for typo_domains");
  return { ...base, ...raw, typo_domains: valid ? (domains as string[]) : base.typo_domains };
}

/** email: shallow merge, but retryable_error_names must be a non-empty string[] (a string would make
 *  `.includes` a substring match; a number would throw inside sendEmail's error path). */
export function loadEmailSection(raw: Record<string, unknown> | undefined): GlobalSettings["email"] {
  const defaults = DEFAULT_GLOBAL.email;
  const rawEmail = raw ?? {};
  const merged = { ...defaults, ...rawEmail } as GlobalSettings["email"];
  const isAddr = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value.includes("@");
  for (const roleKey of ["support", "billing", "privacy", "legal"] as const) {
    if (!isAddr(merged[roleKey])) {
      warnFallback("global.json", `invalid email values for ${roleKey}`);
      merged[roleKey] = defaults[roleKey];
    } else {
      merged[roleKey] = merged[roleKey].trim();
    }
  }
  // Keep sender and from aligned when only one is overridden.
  const rawSender = rawEmail.sender;
  const rawFrom = rawEmail.from;
  if (rawSender !== undefined && !isAddr(rawSender)) {
    warnFallback("global.json", "invalid email values for sender");
    merged.sender = defaults.sender;
  }
  if (rawFrom !== undefined && !isAddr(rawFrom)) {
    warnFallback("global.json", "invalid email values for from");
    merged.from = defaults.from;
  }
  if (rawSender !== undefined && rawFrom === undefined && isAddr(merged.sender)) {
    merged.from = merged.sender;
  } else if (rawFrom !== undefined && rawSender === undefined && isAddr(merged.from)) {
    merged.sender = merged.from;
  }
  const names = rawEmail.retryable_error_names;
  if (names !== undefined && !(Array.isArray(names) && names.length > 0 && names.every((entry) => typeof entry === "string" && entry !== "" && entry === entry.trim()))) {
    warnFallback("global.json", "invalid email values for retryable_error_names");
    merged.retryable_error_names = DEFAULT_GLOBAL.email.retryable_error_names;
  }
  // The concurrent-request status must be a 4xx; anything else would silently never match and reclassify the outcome.
  if (!intInRange(merged.concurrent_request_status, 400, 499)) {
    warnFallback("global.json", "invalid email values for concurrent_request_status");
    merged.concurrent_request_status = DEFAULT_GLOBAL.email.concurrent_request_status;
  }
  if (typeof merged.concurrent_request_error_name !== "string" || merged.concurrent_request_error_name.trim() === "") {
    warnFallback("global.json", "invalid email values for concurrent_request_error_name");
    merged.concurrent_request_error_name = DEFAULT_GLOBAL.email.concurrent_request_error_name;
  }
  if (!intInRange(merged.address_rejected_status, 400, 499)) {
    warnFallback("global.json", "invalid email values for address_rejected_status");
    merged.address_rejected_status = DEFAULT_GLOBAL.email.address_rejected_status;
  }
  return merged;
}

export const BOOK_PREVIEW_LIMITS = {
  render_scale: { min: 1, max: 3 },
  max_preview_pages: { min: 2, max: 32 },
  page_width_px: { min: 200, max: 800 },
  page_height_px: { min: 300, max: 1200 },
  min_width_px: { min: 180, max: 600 },
  max_width_px: { min: 280, max: 900 },
  min_height_px: { min: 240, max: 900 },
  max_height_px: { min: 360, max: 1400 },
  flipping_time_ms: { min: 150, max: 2000 },
  max_shadow_opacity: { min: 0, max: 1 },
  swipe_distance_px: { min: 10, max: 120 },
  visibility_margin_px: { min: 0, max: 1000 },
  zoom_level: { min: 1, max: 3 },
  zoom_levels_length: { min: 2, max: 5 },
  read_aloud_rate: { min: 0.5, max: 3 },
  read_aloud_rates_length: { min: 1, max: 8 },
  read_aloud_max_chunk_chars: { min: 60, max: 500 },
  read_aloud_voice_list_length: { min: 0, max: 50 },
  read_aloud_gender_order_length: { min: 1, max: 2 },
  text_line_y_tolerance: { min: 0.5, max: 12 },
  text_heading_scale_ratio: { min: 1.05, max: 2.5 },
  text_major_heading_scale_ratio: { min: 1.1, max: 3.0 },
  text_paragraph_gap_ratio: { min: 1.1, max: 4.0 },
  text_max_heading_chars: { min: 20, max: 240 },
} as const;

/** BCP 47 primary subtag plus optional subtags, e.g. "en", "en-US", "zh-Hant-TW". Structural format check only. */
const READ_ALOUD_LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Parses read_aloud.voice field by field; any invalid field keeps its default and is reported as a fallback. */
function parseReadAloudVoice(
  raw: unknown,
  defaults: BookPreviewReadAloudVoiceSettings,
  fallbacks: string[],
): BookPreviewReadAloudVoiceSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fallbacks.push("read_aloud.voice");
    return defaults;
  }
  const rec = raw as Record<string, unknown>;
  const pick = <T>(key: string, parse: (value: unknown) => T | null, fallback: T): T => {
    if (!(key in rec)) return fallback;
    const parsed = parse(rec[key]);
    if (parsed !== null) return parsed;
    fallbacks.push(`read_aloud.voice.${key}`);
    return fallback;
  };
  const stringList = (value: unknown): string[] | null => {
    const { min, max } = BOOK_PREVIEW_LIMITS.read_aloud_voice_list_length;
    if (!Array.isArray(value) || value.length < min || value.length > max) return null;
    const trimmed = value.map((item) => (typeof item === "string" ? item.trim() : ""));
    return trimmed.every((item) => item !== "") ? trimmed : null;
  };
  const genderList = (value: unknown): Array<"female" | "male"> | null => {
    const { min, max } = BOOK_PREVIEW_LIMITS.read_aloud_gender_order_length;
    if (!Array.isArray(value) || value.length < min || value.length > max) return null;
    const valid = value.every((g) => g === "female" || g === "male") && new Set(value).size === value.length;
    return valid ? (value as Array<"female" | "male">) : null;
  };
  return {
    lang: pick("lang", (v) => (typeof v === "string" && READ_ALOUD_LANG_RE.test(v.trim()) ? v.trim() : null), defaults.lang),
    quality_markers: pick("quality_markers", stringList, defaults.quality_markers),
    gender_order: pick("gender_order", genderList, defaults.gender_order),
    female_name_hints: pick("female_name_hints", stringList, defaults.female_name_hints),
    male_name_hints: pick("male_name_hints", stringList, defaults.male_name_hints),
  };
}

function isSafeBooksPrefix(prefixValue: unknown): prefixValue is string {
  return typeof prefixValue === "string" && /^\/books\/[a-z0-9_-]+$/.test(prefixValue);
}

export function loadBookPreviewSection(raw: Record<string, unknown> | undefined): BookPreviewSettings {
  const defaults = DEFAULT_GLOBAL.book_preview;
  if (!raw) return defaults;
  const fallbacks: string[] = [];
  const intField = (
    key:
      | "max_preview_pages"
      | "page_width_px"
      | "page_height_px"
      | "min_width_px"
      | "max_width_px"
      | "min_height_px"
      | "max_height_px"
      | "flipping_time_ms"
      | "swipe_distance_px"
      | "visibility_margin_px",
  ): number => {
    if (!(key in raw)) return defaults[key];
    const rawValue = raw[key];
    const { min, max } = BOOK_PREVIEW_LIMITS[key];
    if (intInRange(rawValue, min, max)) return rawValue;
    fallbacks.push(key);
    return defaults[key];
  };
  const floatField = (key: "render_scale" | "max_shadow_opacity"): number => {
    if (!(key in raw)) return defaults[key];
    const rawValue = raw[key];
    const { min, max } = BOOK_PREVIEW_LIMITS[key];
    if (typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue >= min && rawValue <= max) return rawValue;
    fallbacks.push(key);
    return defaults[key];
  };
  const boolField = (key: "show_cover" | "use_portrait"): boolean => {
    if (!(key in raw)) return defaults[key];
    const rawValue = raw[key];
    if (typeof rawValue === "boolean") return rawValue;
    fallbacks.push(key);
    return defaults[key];
  };
  const strField = (key: "heading" | "subheading"): string => {
    if (!(key in raw)) return defaults[key];
    const rawValue = raw[key];
    if (typeof rawValue === "string" && rawValue.trim() !== "") return rawValue.trim();
    fallbacks.push(key);
    return defaults[key];
  };
  let pdfWorkerSrc = defaults.pdf_worker_src;
  if ("pdf_worker_src" in raw) {
    if (typeof raw.pdf_worker_src === "string" && /^\/[a-z0-9/_.-]+\.mjs$/.test(raw.pdf_worker_src) && !raw.pdf_worker_src.includes("..")) {
      pdfWorkerSrc = raw.pdf_worker_src;
    } else {
      fallbacks.push("pdf_worker_src");
    }
  }
  const minW = intField("min_width_px");
  const maxW = Math.max(minW, intField("max_width_px"));
  const minH = intField("min_height_px");
  const maxH = Math.max(minH, intField("max_height_px"));

  let zoomLevels: ReadonlyArray<number> = defaults.zoom_levels;
  if ("zoom_levels" in raw) {
    const candidate = raw.zoom_levels;
    const validZoomArray =
      Array.isArray(candidate) &&
      candidate.length >= BOOK_PREVIEW_LIMITS.zoom_levels_length.min &&
      candidate.length <= BOOK_PREVIEW_LIMITS.zoom_levels_length.max &&
      candidate.every(
        (zoomFactor, idx) =>
          typeof zoomFactor === "number" &&
          Number.isFinite(zoomFactor) &&
          zoomFactor >= BOOK_PREVIEW_LIMITS.zoom_level.min &&
          zoomFactor <= BOOK_PREVIEW_LIMITS.zoom_level.max &&
          (idx === 0 ? zoomFactor === 1 : zoomFactor > (candidate[idx - 1] as number)),
      );
    if (validZoomArray) zoomLevels = [...(candidate as number[])];
    else fallbacks.push("zoom_levels");
  }

  let toolbarLabels: BookPreviewToolbarLabels = defaults.toolbar_labels;
  if ("toolbar_labels" in raw) {
    const tlRaw = raw.toolbar_labels;
    if (tlRaw && typeof tlRaw === "object" && !Array.isArray(tlRaw)) {
      const rec = tlRaw as Record<string, unknown>;
      const labelField = (labelKey: keyof BookPreviewToolbarLabels): string => {
        if (!(labelKey in rec)) return defaults.toolbar_labels[labelKey];
        if (typeof rec[labelKey] === "string" && rec[labelKey].trim() !== "") return rec[labelKey].trim();
        fallbacks.push(`toolbar_labels.${labelKey}`);
        return defaults.toolbar_labels[labelKey];
      };
      toolbarLabels = {
        toolbar_aria_label: labelField("toolbar_aria_label"),
        zoom_in: labelField("zoom_in"),
        zoom_out: labelField("zoom_out"),
        reset_zoom: labelField("reset_zoom"),
        go_to_page: labelField("go_to_page"),
        go_to_page_submit: labelField("go_to_page_submit"),
        prev_page: labelField("prev_page"),
        next_page: labelField("next_page"),
        navigation_aria_label: labelField("navigation_aria_label"),
        region_aria_label: labelField("region_aria_label"),
      };
    } else {
      fallbacks.push("toolbar_labels");
    }
  }

  let readAloud: BookPreviewReadAloudSettings = defaults.read_aloud;
  if ("read_aloud" in raw) {
    const raRaw = raw.read_aloud;
    if (raRaw && typeof raRaw === "object" && !Array.isArray(raRaw)) {
      const rec = raRaw as Record<string, unknown>;
      let enabled = defaults.read_aloud.enabled;
      if ("enabled" in rec) {
        if (typeof rec.enabled === "boolean") enabled = rec.enabled;
        else fallbacks.push("read_aloud.enabled");
      }

      let rates: ReadonlyArray<number> = defaults.read_aloud.rates;
      if ("rates" in rec) {
        const candidate = rec.rates;
        const validRates =
          Array.isArray(candidate) &&
          candidate.length >= BOOK_PREVIEW_LIMITS.read_aloud_rates_length.min &&
          candidate.length <= BOOK_PREVIEW_LIMITS.read_aloud_rates_length.max &&
          candidate.every(
            (rate, idx) =>
              typeof rate === "number" &&
              Number.isFinite(rate) &&
              rate >= BOOK_PREVIEW_LIMITS.read_aloud_rate.min &&
              rate <= BOOK_PREVIEW_LIMITS.read_aloud_rate.max &&
              (idx === 0 || rate > (candidate[idx - 1] as number)),
          );
        if (validRates) rates = [...(candidate as number[])];
        else fallbacks.push("read_aloud.rates");
      }

      let defaultRate = rates.includes(defaults.read_aloud.default_rate)
        ? defaults.read_aloud.default_rate
        : (rates.at(0) ?? defaults.read_aloud.default_rate);
      if ("default_rate" in rec) {
        const dr = rec.default_rate;
        if (typeof dr === "number" && Number.isFinite(dr) && rates.includes(dr)) {
          defaultRate = dr;
        } else {
          fallbacks.push("read_aloud.default_rate");
        }
      }

      let maxChunkChars = defaults.read_aloud.max_chunk_chars;
      if ("max_chunk_chars" in rec) {
        if (
          intInRange(
            rec.max_chunk_chars,
            BOOK_PREVIEW_LIMITS.read_aloud_max_chunk_chars.min,
            BOOK_PREVIEW_LIMITS.read_aloud_max_chunk_chars.max,
          )
        ) {
          maxChunkChars = rec.max_chunk_chars;
        } else {
          fallbacks.push("read_aloud.max_chunk_chars");
        }
      }

      let raLabels: BookPreviewReadAloudLabels = defaults.read_aloud.labels;
      if ("labels" in rec) {
        const lRaw = rec.labels;
        if (lRaw && typeof lRaw === "object" && !Array.isArray(lRaw)) {
          const lRec = lRaw as Record<string, unknown>;
          const raLabelField = (labelKey: keyof BookPreviewReadAloudLabels): string => {
            if (!(labelKey in lRec)) return defaults.read_aloud.labels[labelKey];
            const rawLabel = lRec[labelKey];
            if (typeof rawLabel === "string" && rawLabel.trim() !== "") return rawLabel.trim();
            fallbacks.push(`read_aloud.labels.${labelKey}`);
            return defaults.read_aloud.labels[labelKey];
          };
          raLabels = {
            group_aria_label: raLabelField("group_aria_label"),
            play: raLabelField("play"),
            pause: raLabelField("pause"),
            resume: raLabelField("resume"),
            stop: raLabelField("stop"),
            play_text: raLabelField("play_text"),
            pause_text: raLabelField("pause_text"),
            resume_text: raLabelField("resume_text"),
            stop_text: raLabelField("stop_text"),
            speed_aria_label: raLabelField("speed_aria_label"),
            rate_suffix: raLabelField("rate_suffix"),
            finished_announcement: raLabelField("finished_announcement"),
          };
        } else {
          fallbacks.push("read_aloud.labels");
        }
      }

      let highlightWords = defaults.read_aloud.highlight_words;
      if ("highlight_words" in rec) {
        if (typeof rec.highlight_words === "boolean") highlightWords = rec.highlight_words;
        else fallbacks.push("read_aloud.highlight_words");
      }

      let continueOnPageTurn = defaults.read_aloud.continue_on_page_turn;
      if ("continue_on_page_turn" in rec) {
        if (typeof rec.continue_on_page_turn === "boolean") continueOnPageTurn = rec.continue_on_page_turn;
        else fallbacks.push("read_aloud.continue_on_page_turn");
      }

      const voice = "voice" in rec
        ? parseReadAloudVoice(rec.voice, defaults.read_aloud.voice, fallbacks)
        : defaults.read_aloud.voice;

      readAloud = {
        enabled,
        rates,
        default_rate: defaultRate,
        max_chunk_chars: maxChunkChars,
        highlight_words: highlightWords,
        continue_on_page_turn: continueOnPageTurn,
        voice,
        labels: raLabels,
      };
    } else {
      fallbacks.push("read_aloud");
    }
  }

  let textStructure: BookPreviewTextStructureSettings = defaults.text_structure;
  if ("text_structure" in raw) {
    const tsRaw = raw.text_structure;
    if (tsRaw && typeof tsRaw === "object" && !Array.isArray(tsRaw)) {
      const rec = tsRaw as Record<string, unknown>;
      const tsFloat = (
        fieldKey: "line_y_tolerance" | "heading_scale_ratio" | "major_heading_scale_ratio" | "paragraph_gap_ratio",
        limitKey: "text_line_y_tolerance" | "text_heading_scale_ratio" | "text_major_heading_scale_ratio" | "text_paragraph_gap_ratio",
      ): number => {
        if (!(fieldKey in rec)) return defaults.text_structure[fieldKey];
        const rawValue = rec[fieldKey];
        const { min, max } = BOOK_PREVIEW_LIMITS[limitKey];
        if (typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue >= min && rawValue <= max) return rawValue;
        fallbacks.push(`text_structure.${fieldKey}`);
        return defaults.text_structure[fieldKey];
      };
      const tsStr = (fieldKey: "toggle_single" | "toggle_plural" | "page_label_prefix"): string => {
        if (!(fieldKey in rec)) return defaults.text_structure[fieldKey];
        const rawLabel = rec[fieldKey];
        if (typeof rawLabel === "string" && rawLabel.trim() !== "") return rawLabel.trim();
        fallbacks.push(`text_structure.${fieldKey}`);
        return defaults.text_structure[fieldKey];
      };
      const headingRatio = tsFloat("heading_scale_ratio", "text_heading_scale_ratio");
      const majorRatioRaw = tsFloat("major_heading_scale_ratio", "text_major_heading_scale_ratio");
      const majorRatio = majorRatioRaw >= headingRatio ? majorRatioRaw : Math.max(headingRatio, defaults.text_structure.major_heading_scale_ratio);
      if (majorRatioRaw < headingRatio) fallbacks.push("text_structure.major_heading_scale_ratio");

      let maxHeadingChars = defaults.text_structure.max_heading_chars;
      if ("max_heading_chars" in rec) {
        if (intInRange(rec.max_heading_chars, BOOK_PREVIEW_LIMITS.text_max_heading_chars.min, BOOK_PREVIEW_LIMITS.text_max_heading_chars.max)) {
          maxHeadingChars = rec.max_heading_chars;
        } else {
          fallbacks.push("text_structure.max_heading_chars");
        }
      }

      textStructure = {
        line_y_tolerance: tsFloat("line_y_tolerance", "text_line_y_tolerance"),
        heading_scale_ratio: headingRatio,
        major_heading_scale_ratio: majorRatio,
        paragraph_gap_ratio: tsFloat("paragraph_gap_ratio", "text_paragraph_gap_ratio"),
        max_heading_chars: maxHeadingChars,
        toggle_single: tsStr("toggle_single"),
        toggle_plural: tsStr("toggle_plural"),
        page_label_prefix: tsStr("page_label_prefix"),
      };
    } else {
      fallbacks.push("text_structure");
    }
  }

  if (fallbacks.length > 0) warnFallback("global.json", `invalid book_preview values for ${fallbacks.join(", ")}`);
  return {
    pdf_worker_src: pdfWorkerSrc,
    render_scale: floatField("render_scale"),
    max_preview_pages: intField("max_preview_pages"),
    page_width_px: intField("page_width_px"),
    page_height_px: intField("page_height_px"),
    min_width_px: minW,
    max_width_px: maxW,
    min_height_px: minH,
    max_height_px: maxH,
    flipping_time_ms: intField("flipping_time_ms"),
    max_shadow_opacity: floatField("max_shadow_opacity"),
    swipe_distance_px: intField("swipe_distance_px"),
    visibility_margin_px: intField("visibility_margin_px"),
    show_cover: boolField("show_cover"),
    use_portrait: boolField("use_portrait"),
    heading: strField("heading"),
    subheading: strField("subheading"),
    zoom_levels: zoomLevels,
    toolbar_labels: toolbarLabels,
    read_aloud: readAloud,
    text_structure: textStructure,
  };
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
  /** The processor's name as a buyer reads it (the merchant-of-record line on checkout). Falls back to the provider key. */
  display_name?: string;
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
  /** Checkout link capability: appends `reference_id=<attribution>` on redirect links (Polar). */
  supports_reference_id?: boolean;
  /** Checkout link capability: query param carrying the attribution reference when not `reference_id` (e.g. Creem `metadata[order_ref]`). */
  order_ref_param?: string | null;
  /** Checkout link capability: query param carrying buyer email prefill (`customer_email`, `user_email`, or null). */
  buyer_email_param?: string | null;
  /** Checkout link capability: appends `metadata[<buyer_consent_metadata_key>]=true|false`. */
  supports_consent_metadata?: boolean;
  /** Checkout link capability: query param carrying internal product id metadata (`metadata[product_id]`). */
  metadata_product_id_param?: string | null;
  /** Checkout link capability: query param carrying the thank-you `success_url` when not already present. */
  success_url_param?: string | null;
  /** Checkout link capability: query param carrying checkout theme mode (`theme=light|dark`). */
  theme_param?: string | null;
  /** Provider-owned external product ID column on `public.products` (e.g. `paddle_product_id`), matched only for this provider. */
  product_id_column?: string | null;
  /** Additional provider-specific alias columns on `public.products` (e.g. Polar sandbox/live columns). */
  extra_product_id_columns?: string[];
  /** Webhook capability: true when a sale event may arrive without inline buyerEmail and resolve it via API/customer lookup. */
  allows_deferred_buyer_email?: boolean;
  /**
   * Launch switch. A provider is fully defined and its code is kept; this flag decides whether it takes sales.
   * Missing or false = off (fail closed). Off providers keep their config and verifier, and the webhook route refuses them.
   */
  enabled?: boolean;
}

// Inline mirror of data/settings/providers.json "payments" section (fallback contract).
export const DEFAULT_PAYMENT_PROVIDERS = {
  lemonsqueezy: {
    enabled: false,
    display_name: "Lemon Squeezy",
    route: "lemonsqueezy",
    signature_header: "x-signature",
    sale_event: "order_created",
    checkout_param: "checkout[custom][product_id]",
    secret_env: "LEMONSQUEEZY_WEBHOOK_SECRET",
    supports_reference_id: false,
    order_ref_param: null,
    buyer_email_param: null,
    supports_consent_metadata: false,
    metadata_product_id_param: null,
    success_url_param: null,
    theme_param: null,
    product_id_column: null,
    allows_deferred_buyer_email: false,
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
    display_name: "Payhip",
    route: "payhip",
    signature_header: null,
    signature_field: "signature",
    signature_scheme: "in-payload sha256-hex: body.signature = sha256(Payhip API key) hex — NOT a body HMAC (help.payhip.com/article/115-webhooks, updated 2026-07-22)",
    sale_events: ["paid"],
    refund_events: ["refunded"],
    secret_env: "PAYHIP_WEBHOOK_SECRET",
    supports_reference_id: false,
    order_ref_param: null,
    buyer_email_param: null,
    supports_consent_metadata: false,
    metadata_product_id_param: null,
    success_url_param: null,
    theme_param: null,
    product_id_column: null,
    allows_deferred_buyer_email: false,
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
    display_name: "Paddle.com",
    route: "paddle",
    signature_header: "paddle-signature",
    sale_event: "transaction.completed",
    secret_env: "PADDLE_WEBHOOK_SECRET",
    supports_reference_id: false,
    order_ref_param: null,
    buyer_email_param: "user_email",
    supports_consent_metadata: false,
    metadata_product_id_param: null,
    success_url_param: null,
    theme_param: null,
    product_id_column: "paddle_product_id",
    allows_deferred_buyer_email: true,
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
    display_name: "FastSpring",
    route: "fastspring",
    signature_header: "x-fs-signature",
    signature_scheme: "hmac-sha256-base64: `x-fs-signature` = base64(HMAC-SHA256(raw_body, secret)) (developer.fastspring.com/reference/message-security)",
    sale_events: ["order.completed"],
    refund_events: ["return.created"],
    live_gate: "data.live",
    secret_env: "FASTSPRING_WEBHOOK_SECRET",
    supports_reference_id: false,
    order_ref_param: null,
    buyer_email_param: null,
    supports_consent_metadata: false,
    metadata_product_id_param: null,
    success_url_param: null,
    theme_param: null,
    product_id_column: null,
    allows_deferred_buyer_email: false,
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
    display_name: "Polar",
    route: "polar",
    signature_header: "webhook-signature",
    signature_scheme: "standard-webhooks: HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${raw_body}`, base64; whsec_ secrets created on/after 2026-09-08 = base64-decoded, older = UTF-8 bytes of full string",
    sale_events: ["order.created", "order.paid"],
    refund_events: ["refund.created"],
    secret_env: "POLAR_WEBHOOK_SECRET",
    token_env: "POLAR_ACCESS_TOKEN",
    supports_reference_id: true,
    order_ref_param: null,
    buyer_email_param: "customer_email",
    supports_consent_metadata: false,
    metadata_product_id_param: null,
    success_url_param: null,
    theme_param: "theme",
    product_id_column: null,
    extra_product_id_columns: ["polar_product_id_sandbox", "polar_product_id_live"],
    allows_deferred_buyer_email: false,
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
  creem: {
    display_name: "Creem",
    // Defined so the registry knows Creem, but off until the founder approves it as a launch rail (Paddle-only launch).
    // Production has no providers.json, so this entry is the only switch; flip it to route Creem checkout and webhooks.
    enabled: false,
    route: "creem",
    signature_header: "creem-signature",
    sale_event: "checkout.completed",
    secret_env: "CREEM_WEBHOOK_SECRET",
    supports_reference_id: false,
    order_ref_param: "metadata[order_ref]",
    buyer_email_param: null,
    supports_consent_metadata: true,
    metadata_product_id_param: "metadata[product_id]",
    success_url_param: "success_url",
    theme_param: "theme",
    product_id_column: null,
    allows_deferred_buyer_email: false,
    field_map: {
      product_id: "data.order.product",
      sale_id: "data.order.id",
      total_cents: "data.order.amount_paid",
      total_cents_fallback: "data.order.amount",
      currency: "data.order.currency",
      email: "data.customer.email",
      attribution_id: "data.metadata.order_ref",
    },
  },
  fungies: {
    // Off until the founder approves Fungies as a launch rail. Its verifier stays wired so it can be switched on.
    enabled: false,
    display_name: "Fungies",
    route: "fungies",
    signature_header: "x-fngs-signature",
    signature_scheme:
      "hmac-sha256-hex: `x-fngs-signature: sha256_<hex>` = HMAC-SHA256(raw_body, webhook_secret) hex (docs.fungies.io/developers/webhooks/setup, verified 2026-09-15)",
    sale_events: ["payment_success"],
    secret_env: "FUNGIES_WEBHOOK_SECRET",
    supports_reference_id: false,
    order_ref_param: null,
    buyer_email_param: null,
    supports_consent_metadata: false,
    metadata_product_id_param: null,
    success_url_param: null,
    theme_param: null,
    product_id_column: null,
    allows_deferred_buyer_email: false,
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
} satisfies Record<string, PaymentProviderSetting>;

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

/** Buyer-facing processor name for the Merchant of Record line on checkout (registry display_name, falling back to default or key). */
export function paymentProviderDisplayName(name: string): string {
  const defaults = DEFAULT_PAYMENT_PROVIDERS as Record<string, PaymentProviderSetting>;
  const raw = paymentProviderSetting(name)?.display_name ?? defaults[name]?.display_name;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : name;
}

const SAFE_COLUMN_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Provider-specific external product-id column on `public.products` (`product_id_column`), if any. */
export function paymentProviderProductIdColumn(name: string): string | null {
  const defaults = DEFAULT_PAYMENT_PROVIDERS as Record<string, PaymentProviderSetting>;
  const col = paymentProviderSetting(name)?.product_id_column ?? defaults[name]?.product_id_column;
  return typeof col === "string" && SAFE_COLUMN_RE.test(col) ? col : null;
}

/** Provider-specific external product-id columns (primary `product_id_column` + any `extra_product_id_columns`). */
export function paymentProviderProductIdColumns(name: string): string[] {
  const defaults = DEFAULT_PAYMENT_PROVIDERS as Record<string, PaymentProviderSetting>;
  const primary = paymentProviderProductIdColumn(name);
  const extra = paymentProviderSetting(name)?.extra_product_id_columns ?? defaults[name]?.extra_product_id_columns ?? [];
  const out: string[] = [];
  if (primary) out.push(primary);
  for (const col of extra) {
    if (typeof col === "string" && SAFE_COLUMN_RE.test(col) && !out.includes(col)) out.push(col);
  }
  return out;
}

/** True when a provider may send sale webhooks without an inline buyerEmail (resolved later via API/lookup). */
export function allowsDeferredBuyerEmail(name: string): boolean {
  const defaults = DEFAULT_PAYMENT_PROVIDERS as Record<string, PaymentProviderSetting>;
  const setting = paymentProviderSetting(name) ?? defaults[name];
  return setting?.allows_deferred_buyer_email === true;
}

/** Field map for a provider (registry `field_map` with inline default fallback). */
export function paymentProviderFieldMap(name: string): Record<string, string | undefined> {
  const defaults = DEFAULT_PAYMENT_PROVIDERS as Record<string, PaymentProviderSetting>;
  const fm = paymentProviderSetting(name)?.field_map ?? defaults[name]?.field_map;
  return (fm && typeof fm === "object" && !Array.isArray(fm) ? fm : {}) as Record<string, string | undefined>;
}

/** Reads a configured field from a webhook payload using `PAYMENT_PROVIDERS[provider].field_map[fieldKey]`. */
export function readProviderField(payload: unknown, provider: string, fieldKey: string): unknown {
  return getPath(payload, paymentProviderFieldMap(provider)[fieldKey]);
}

/** First enabled payment provider in the registry, or null when all providers are switched off. */
export function defaultEnabledPaymentProvider(): string | null {
  return Object.keys(PAYMENT_PROVIDERS).find((name) => isEnabledPaymentProvider(name)) ?? null;
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
