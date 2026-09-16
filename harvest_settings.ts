// harvest_settings.ts — settings-registry loader for harvest.ts (audit:
// data/intel/settings_registry_audit_2026-09-14.md, harvest.ts table — 11 rows).
// Reads data/settings/harvest.json (cwd-relative) merged over DEFAULT_HARVEST inline
// fallbacks mirroring the committed registry, so standalone execution behaves identically.
// Split out of harvest.ts because harvest.ts runs its 5-engine harvest at module top-level
// with no import guard (documented 2026-09-09) — this module is pure, so settings-gates and
// other importers can load harvest settings without firing a live harvest.
// Engine model ids stay env-overridable (SONAR_MODEL / GROK_MODEL, .env per AGENTS.md).
import { existsSync, readFileSync } from "node:fs";
import { dataProviderSetting } from "@payments/settings_registry";

export interface HarvestSettings {
  models: { sonar: string; grok: string };
  engines: {
    sonar: { temperature: number };
    grok: { temperature: number; plugins: { id: string }[] };
    exa: { query: string; num_results: number };
    brave: { query: string };
    serp: { engine: string; geo: string };
    serp_ads: { engine: string };
  };
  prompt_item_range: { min: number; max: number };
  recency_days: number;
}

const DEFAULT_HARVEST: HarvestSettings = {
  models: { sonar: "perplexity/sonar", grok: "x-ai/grok-4.3" },
  engines: {
    sonar: { temperature: 0.2 },
    grok: { temperature: 0.3, plugins: [{ id: "web" }] },
    exa: { query: "there's no good tool for OR I built a spreadsheet to solve", num_results: 15 },
    brave: { query: "new+trending+digital+product+2026" },
    serp: { engine: "google_trends_trending_now", geo: "US" },
    serp_ads: { engine: "google" },
  },
  prompt_item_range: { min: 8, max: 15 },
  recency_days: 90,
};

function readHarvestJson(): Partial<HarvestSettings> | undefined {
  const p = "data/settings/harvest.json";
  if (!existsSync(p)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Partial<HarvestSettings>;
    }
  } catch {
    // unreadable/invalid -> inline defaults
  }
  return undefined;
}

export function loadHarvestSettings(): HarvestSettings {
  const raw = readHarvestJson();
  if (!raw) return DEFAULT_HARVEST;
  return {
    models: { ...DEFAULT_HARVEST.models, ...(raw.models ?? {}) },
    engines: {
      sonar: { ...DEFAULT_HARVEST.engines.sonar, ...(raw.engines?.sonar ?? {}) },
      grok: { ...DEFAULT_HARVEST.engines.grok, ...(raw.engines?.grok ?? {}) },
      exa: { ...DEFAULT_HARVEST.engines.exa, ...(raw.engines?.exa ?? {}) },
      brave: { ...DEFAULT_HARVEST.engines.brave, ...(raw.engines?.brave ?? {}) },
      serp: { ...DEFAULT_HARVEST.engines.serp, ...(raw.engines?.serp ?? {}) },
      serp_ads: { ...DEFAULT_HARVEST.engines.serp_ads, ...(raw.engines?.serp_ads ?? {}) },
    },
    prompt_item_range: { ...DEFAULT_HARVEST.prompt_item_range, ...(raw.prompt_item_range ?? {}) },
    recency_days: raw.recency_days ?? DEFAULT_HARVEST.recency_days,
  };
}

export const HARVEST: HarvestSettings = loadHarvestSettings();

/** Decodo Web Scraping API endpoint — providers.json data.decodo.scraping_endpoint (audit row harvest.ts:134). */
const DEFAULT_DECODO_SCRAPE = "https://scraper-api.decodo.com/v2/scrape";

export function decodoScrapingEndpoint(): string {
  return dataProviderSetting("decodo")?.scraping_endpoint ?? DEFAULT_DECODO_SCRAPE;
}
