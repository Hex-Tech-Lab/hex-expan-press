// harvest.ts — grounded multi-source harvester, run via `pnpm harvest`
import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import dotenv from "dotenv";
import { HARVEST, decodoScrapingEndpoint } from "@/harvest_settings";
dotenv.config({ override: true });

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = `data/run_${RUN_ID}`;
mkdirSync(RUN_DIR, { recursive: true });
mkdirSync("data/cache", { recursive: true });

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

interface CacheEnvelope<T> {
  fetched_at: number;
  data: T;
}

export async function cachedFetch<T>(key: string, ttlMs: number, fetchFn: () => Promise<T>): Promise<T> {
  const cacheFile = `data/cache/${hash(key)}.json`;
  if (existsSync(cacheFile)) {
    const cached: CacheEnvelope<T> = JSON.parse(readFileSync(cacheFile, "utf-8"));
    if (Date.now() - cached.fetched_at < ttlMs) {
      console.log(`==> cache hit: ${key.slice(0, 50)}`);
      return cached.data;
    }
  }
  const data = await fetchFn();
  if (
    (data && typeof data === "object" && "error" in (data as object)) ||
    (Array.isArray(data) && data.length === 0)
  ) {
    console.log(`==> not caching empty/error response: ${key.slice(0, 50)}`);
    return data;
  }
  writeFileSync(cacheFile, JSON.stringify({ fetched_at: Date.now(), data } satisfies CacheEnvelope<T>));
  return data;
}

const TTL_6H = 6 * 60 * 60 * 1000;

async function postJson<T = unknown>(url: string, headers: Record<string, string>, body: unknown): Promise<T | { error: string; body?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, body: await res.text() };
    return (await res.json()) as T;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface OrChatResponse {
  choices?: { message?: { content?: string } }[];
}

// Validated same-provider retry for direct OpenRouter LLM calls (provider-pin hardening
// 2026-09-16): HTTP 200 is NOT acceptance — the response content must actually validate
// (validator returns null when the expected shape is present, else a reason). A
// 200-but-garbage response is retried on the SAME pinned provider with backoff, max 3
// attempts; it never falls through to a different provider (that would reintroduce the
// budget-provider drift/cache-loss the pin exists to prevent). After 3 attempts: loud
// console.error + {error} return — cachedFetch refuses to cache error objects, so the
// failed engine is visibly absent from the run instead of poisoning the cache.
async function postOrValidated(
  what: string,
  body: unknown,
  validate: (content: string) => string | null
): Promise<OrChatResponse | { error: string; body?: string }> {
  const MAX_ATTEMPTS = 3;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await postJson<OrChatResponse>(
      "https://openrouter.ai/api/v1/chat/completions",
      { "X-Title": "hex-expan", "HTTP-Referer": "https://github.com/TechHypeXP/hex-expan", Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body
    );
    if ("error" in (res as object)) {
      lastError = (res as { error: string }).error;
    } else {
      const content = (res as OrChatResponse).choices?.[0]?.message?.content ?? "";
      const reason = validate(content);
      if (reason === null) return res as OrChatResponse;
      lastError = `HTTP 200 but content invalid: ${reason}`;
    }
    console.error(`==> [${what}] attempt ${attempt}/${MAX_ATTEMPTS} rejected: ${lastError}`);
    if (attempt < MAX_ATTEMPTS) await sleep(3_000);
  }
  console.error(`==> [${what}] FAILED after ${MAX_ATTEMPTS} same-provider attempts — recorded as engine error (not cached)`);
  return { error: `${what}: gave up after ${MAX_ATTEMPTS} validated attempts; last: ${lastError}` };
}

// Shape validator for the harvest engine prompts (both demand a JSON array of items):
// content must contain a parseable JSON array. Empty arrays are legal data (sparse signal
// night), not a validation failure — but they flow through cachedFetch's empty-array guard.
function jsonArrayValidator(content: string): string | null {
  try {
    const start = content.indexOf("[");
    const end = content.lastIndexOf("]");
    if (start === -1 || end === -1) return "no JSON array found in LLM output";
    return Array.isArray(JSON.parse(content.slice(start, end + 1))) ? null : "LLM output is not a JSON array";
  } catch (e) {
    return (e as Error).message;
  }
}

async function getJson<T = unknown>(url: string, headers: Record<string, string> = {}): Promise<T | { error: string }> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return (await res.json()) as T;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// --- 1. Sonar (via OpenRouter) — GROUNDED ONLY ---
async function fetchSonar() {
  const prompt = `Analyze Reddit, G2, Trustpilot, Whop, and Gumroad for digital
products/templates/micro-tools with documented recent sales velocity or
recurring complaint threads. Do NOT invent categories — only report items
with a traceable source (URL, subreddit, product listing). Return a JSON
array of ${HARVEST.prompt_item_range.min} to ${HARVEST.prompt_item_range.max} items:
[{title, category, evidence_url, evidence_quote, signal_type}]
If fewer than ${HARVEST.prompt_item_range.min} fully-sourced items exist, include the strongest
partial-evidence candidates and set their signal_type to "partial".`;
  return cachedFetch(`sonar:${prompt}`, TTL_6H, () =>
    postOrValidated("sonar", {
        model: process.env.SONAR_MODEL || HARVEST.models.sonar,
        // Direct OR calls bypass the opencode CLI relace pin (RCA 2026-09-16); pin to the
        // model's only serving provider — sonar is Perplexity-exclusive, a GLM-style pin would 400.
        provider: { order: ["perplexity"], allow_fallbacks: false },
        messages: [
          { role: "system", content: "Return valid JSON only. No commentary." },
          { role: "user", content: prompt },
        ],
        temperature: HARVEST.engines.sonar.temperature,
      },
      jsonArrayValidator)
  );
}

// --- 2. Grok (via OpenRouter) — GROUNDED, X-native signals only ---
async function fetchGrok() {
  const prompt = `Search the web (X, Reddit, forums) for operator/founder
complaints and "is there a tool for X" posts from the last ${HARVEST.recency_days} days. Only
report posts you can quote or paraphrase from actual content, with source
links where available. Return a JSON array of ${HARVEST.prompt_item_range.min} to ${HARVEST.prompt_item_range.max} items:
[{topic, quote_summary, urgency, source_context, source_url}]`;
  return cachedFetch(`grok:${prompt}`, TTL_6H, () =>
    postOrValidated("grok", {
        model: process.env.GROK_MODEL || HARVEST.models.grok,
        plugins: HARVEST.engines.grok.plugins,
        // grok-4.3 is xAI-exclusive (OR endpoints API) — provider pin for direct-OR-call determinism.
        provider: { order: ["x-ai"], allow_fallbacks: false },
        messages: [
          { role: "system", content: "Return valid JSON only. No commentary." },
          { role: "user", content: prompt },
        ],
        temperature: HARVEST.engines.grok.temperature,
      },
      jsonArrayValidator)
  );
}

// --- 3. SerpAPI: Google Trends breakouts ---
async function fetchSerpTrends() {
  return cachedFetch("serp:trends", TTL_6H, () =>
    getJson(`https://serpapi.com/search.json?engine=${HARVEST.engines.serp.engine}&geo=${HARVEST.engines.serp.geo}&api_key=${process.env.SERPAPI_API_KEY}`)
  );
}

// --- Phase 3 only — call per candidate, NOT in main run() ---
export async function fetchSerpAdDensity(query: string) {
  const encoded = encodeURIComponent(query);
  return cachedFetch(`serp:ads:${query}`, TTL_6H, () =>
    getJson(`https://serpapi.com/search.json?engine=${HARVEST.engines.serp_ads.engine}&q=${encoded}&api_key=${process.env.SERPAPI_API_KEY}`)
  );
}

export async function fetchDecodo(targetUrl: string) {
  return cachedFetch(`decodo:${targetUrl}`, TTL_6H, () =>
    postJson(
      decodoScrapingEndpoint(),
      { Authorization: `Basic ${process.env.DECODO_SCRAPING_API_AUTH}` },
      { url: targetUrl }
    )
  );
}

// --- 4. Exa: neural semantic search for unmet-demand pages ---
async function fetchExa() {
  return cachedFetch("exa:unmet-demand", TTL_6H, () =>
    postJson(
      "https://api.exa.ai/search",
      { "x-api-key": process.env.EXA_API_KEY ?? "" },
      {
        query: HARVEST.engines.exa.query,
        type: "neural",
        numResults: HARVEST.engines.exa.num_results,
        contents: { text: true },
      }
    )
  );
}

// --- 5. Brave Search — primary + backup key fallback ---
async function fetchBrave() {
  return cachedFetch("brave:trending-tools", TTL_6H, async () => {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${HARVEST.engines.brave.query}`;
    const primary = await getJson(url, { "X-Subscription-Token": process.env.BRAVE_API_KEY ?? "" });
    if ("error" in (primary as object)) {
      return getJson(url, { "X-Subscription-Token": process.env.BRAVE_API_KEY_BACKUP ?? "" });
    }
    return primary;
  });
}

// --- Orchestrate main run: 5 harvest engines, Phase-3 tools excluded ---
async function run() {
  console.log(`==> Run ${RUN_ID} starting`);
  const [sonar, grok, serpTrends, exa, brave] = await Promise.allSettled([
    fetchSonar(),
    fetchGrok(),
    fetchSerpTrends(),
    fetchExa(),
    fetchBrave(),
  ]);

  const unwrap = <T,>(r: PromiseSettledResult<T>) =>
    r.status === "fulfilled" ? r.value : { error: (r as PromiseRejectedResult).reason?.message ?? "unknown" };

  const payload = {
    meta: { run_id: RUN_ID, generated_at: new Date().toISOString() },
    sources: {
      sonar_grounded: unwrap(sonar),
      grok_grounded: unwrap(grok),
      serpapi_trends: unwrap(serpTrends),
      exa_neural: unwrap(exa),
      brave_web: unwrap(brave),
    },
  };

  const outFile = `${RUN_DIR}/payload.json`;
  writeFileSync(outFile, JSON.stringify(payload, null, 2));

  appendFileSync(
    "data/index.jsonl",
    JSON.stringify({
      run_id: RUN_ID,
      timestamp: payload.meta.generated_at,
      file: outFile,
      source_count: Object.keys(payload.sources).length,
    }) + "\n"
  );

  console.log(`==> Payload written: ${outFile}`);
  console.log(`==> Index updated: data/index.jsonl`);
}

run();
