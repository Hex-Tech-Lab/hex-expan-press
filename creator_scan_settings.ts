// creator_scan_settings.ts — settings loaders for creator_scan.ts (audit:
// data/intel/settings_registry_audit_2026-09-14.md, creator_scan.ts table — 16 rows).
// Split out of creator_scan.ts because creator_scan.ts runs its full 4-stage scan (main())
// at module top-level with no import guard — this module is pure, so settings-gates and
// other importers can load scan settings without firing a live scan.
// Sources (audit-proposed homes, reconciled with the existing config file):
//   - config/creator_scan.json — creator_scan's OWN tunables file (AGENTS.md documents it;
//     migration to data/settings/ deferred per audit "creator_scan.json stays at config/",
//     --config=<path> override preserved) — extended with the audit's contact/regex/temperature keys.
//   - data/settings/global.json (user_agent, endpoints.openrouter_chat) +
//     data/settings/providers.json data section (hikerapi/youtube endpoints) — via the
//     payments settings-registry loader (@payments/settings_registry), no secrets inlined.
//   - data/settings/sampling.json (instagram.recent_posts) — LOCKED sampling-spec number.
// Every registry read carries an inline fallback mirroring the committed registry file
// (standing rule) — standalone execution behaves identically.
import { existsSync, readFileSync } from "node:fs";
import { GLOBAL, dataProviderSetting } from "@payments/settings_registry";

export interface CreatorScanConfig {
  niches: string[];
  followerMin: number;
  followerMax: number;
  activityWindowDays: number;
  countryFilter: string;
  language: string;
  defaultN: number;
  cacheTtlHours: number;
  braveRateLimitMs: number;
  instagramRateLimitMs: number;
  decodoFetchDelayMs: number;
  exaNumResults: number;
  exaTextMaxChars: number;
  braveNicheResultCount: number;
  braveContactHuntResultCount: number;
  promptTextExcerptMaxChars: number;
  structuringModel: string;
  trendFreshnessHours: number;
  structuringTemperature: number;
  emailJunkRegex: string;
  storeSignalRegex: string;
  contactHuntQueryTmpl: string;
  contactHuntTopPages: number;
  maxEmailsPerCreator: number;
  minHtmlChars: number;
  contactFetch: { timeoutS: number; maxBufferBytes: number; timeoutMs: number };
}

const CONFIG_DEFAULTS: CreatorScanConfig = {
  niches: ["business coaching", "personal finance", "fitness training", "self-improvement", "creative skills"],
  followerMin: 10_000,
  followerMax: 150_000,
  activityWindowDays: 60,
  countryFilter: "US",
  language: "English",
  defaultN: 20,
  cacheTtlHours: 6,
  braveRateLimitMs: 1100,
  instagramRateLimitMs: 500,
  decodoFetchDelayMs: 800,
  exaNumResults: 12,
  exaTextMaxChars: 500,
  braveNicheResultCount: 10,
  braveContactHuntResultCount: 6,
  promptTextExcerptMaxChars: 1000,
  structuringModel: "x-ai/grok-4.3",
  trendFreshnessHours: 6,
  structuringTemperature: 0.1,
  emailJunkRegex: "(png|jpg|jpeg|gif|webp|svg|css|js|example\\.)$",
  storeSignalRegex: "linktr\\.ee|linkin\\.bio|shop\\b|store\\b|course\\b|gumroad|etsy\\.com|\"buy now\"",
  contactHuntQueryTmpl: "\"{name}\" {niche} email contact business -site:youtube.com",
  contactHuntTopPages: 2,
  maxEmailsPerCreator: 2,
  minHtmlChars: 200,
  contactFetch: { timeoutS: 60, maxBufferBytes: 32 * 1024 * 1024, timeoutMs: 70_000 },
};

interface CreatorScanFileConfig extends Partial<Omit<CreatorScanConfig, "contactFetch">> {
  contactFetch?: Partial<CreatorScanConfig["contactFetch"]>;
}

export function loadCreatorScanConfig(): CreatorScanConfig {
  const argv = process.argv.slice(2);
  const configArg = argv.find((a) => a.startsWith("--config="));
  const configPath = configArg ? configArg.split("=")[1] : "config/creator_scan.json";
  if (!existsSync(configPath)) {
    console.log(`==> config file ${configPath} not found — using built-in defaults`);
    return CONFIG_DEFAULTS;
  }
  try {
    const fileConfig = JSON.parse(readFileSync(configPath, "utf-8")) as CreatorScanFileConfig;
    const { contactFetch, ...rest } = fileConfig;
    return {
      ...CONFIG_DEFAULTS,
      ...rest,
      contactFetch: { ...CONFIG_DEFAULTS.contactFetch, ...(contactFetch ?? {}) },
    };
  } catch (err) {
    console.error(`==> failed to parse ${configPath}, using built-in defaults:`, (err as Error).message);
    return CONFIG_DEFAULTS;
  }
}

export function creatorScanUserAgent(): string {
  return GLOBAL.user_agent;
}

export function creatorScanOpenrouterChatUrl(): string {
  return GLOBAL.endpoints.openrouter_chat;
}

export function hikerapiUserEndpoint(): string {
  const p = dataProviderSetting("hikerapi");
  return `${p?.base ?? "https://api.hikerapi.com"}${p?.endpoints?.user_by_username ?? "/v1/user/by/username"}`;
}

export function hikerapiMediasEndpoint(): string {
  const p = dataProviderSetting("hikerapi");
  return `${p?.base ?? "https://api.hikerapi.com"}${p?.endpoints?.medias_chunk ?? "/v1/user/medias/chunk"}`;
}

export function hikerapiAuthHeader(): string {
  return dataProviderSetting("hikerapi")?.auth_header ?? "x-access-key";
}

export function youtubeEndpoint(name: "videos" | "channels"): string {
  const p = dataProviderSetting("youtube");
  return `${p?.base ?? "https://www.googleapis.com/youtube/v3"}${p?.endpoints?.[name] ?? (name === "videos" ? "/videos" : "/channels")}`;
}

/** Instagram recent-posts sample size — data/settings/sampling.json instagram.recent_posts (LOCKED sampling spec). */
export function instagramRecentPosts(): number {
  for (const p of ["data/settings/sampling.json"]) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as { instagram?: { recent_posts?: number } };
      if (typeof parsed.instagram?.recent_posts === "number") return parsed.instagram.recent_posts;
    } catch {
      // unreadable/invalid -> inline default
    }
  }
  return 5;
}
