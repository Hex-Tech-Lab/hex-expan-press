# AGENTS.md

Trend-harvest + digital-product qualification pipeline. Flat repo, public GitHub repo since 2026-09-10 (`github.com/TechHypeXP/hex-expan` — public because CodeRabbit/Cubic PR-review tools need it on their free tiers; `.env`, `data/`, `downloads/` all gitignored). TypeScript-only, run via tsx. No test suite.

## Commands

```bash
pnpm harvest                  # fire 5 grounded engines -> data/run_*/payload.json
pnpm score -- --top=12        # PHASE 3 only: Vs-score + rank (needs candidates.json first)
pnpm report                   # render latest scored.json -> report.md + self-contained report.html
pnpm transcribe -- --watch    # live/one-shot whisper transcription via OpenRouter STT (see notes below)
pnpm creator-scan             # micro-creator finder: Exa+Brave discovery (YouTube+Instagram) -> real-stat verify -> contact hunt
                               #   tunables (niches, follower band, activity window, rate limits, model) live in
                               #   config/creator_scan.json, not hardcoded — pass --config=<path> to override
pnpm registry-report          # data/db/{runs.jsonl,creators.json} -> data/db/registry_report.html (New/Reviewed/Contacted/Converted view)
pnpm scrape                   # getinsight_id_br.ts (ideabrowser deferred; kept for Whop/Gumroad targets)
```

## Scheduled scanning (since 2026-09-10)

`scripts/scheduled_creator_scan.sh` runs `creator-scan` + `registry-report`. Ramp was 6x/day
(every 4h) for the first 4 days since 2026-09-10 (`.scan_schedule_start`); steady state = 1x/day
at 09:00 Cairo. **BUG FIXED 2026-09-14:** the old cron (`0 */4 * * *`) fires only at
00/04/08/12/16/20 Cairo, but the script's steady-state condition demands `HOUR_CAIRO = 09` —
an unreachable slot, so the scan would have silently never run again. Cron is now
`0 9 * * *` (09:00 Cairo daily). Lesson: the cron grid and the script's slot check must be
derived from each other, not authored independently. Also: cron slots missed while the
machine is off do NOT queue (no anacron in WSL) — a missed 09:00 means zero scans that day.
Logs to `data/db/scheduled_scan.log`. Weak-harvest nights happen: strict hard filter
(10k-150k real follower band, US-only) can legitimately produce 0 candidates (first
occurrence 2026-09-14 00:00 Cairo run; dropped examples ranged 1.2k-1.75M).

OpenRouter also serves Speech-to-Text: `POST /api/v1/audio/transcriptions`, JSON body `{model: "openai/whisper-large-v3-turbo[:nitro]", input_audio: {data: <base64>, format: "mp3"|"wav"|...}}` — ~$0.012/audio-hour. Growing yt-dlp `.part` files are ffmpeg-readable mid-stream (live transcription possible).

Brave free tier = 1 req/sec (`x-ratelimit-policy: 1;w=1`) — serialize calls with ≥1.1s stagger or everything past the first request 429s. Brave also returns HTTP 200 with `bad_results:true` + `{mixed:{main:[]}}` shape for over-constrained queries — the poison-guard misses this shape (no `error` key, non-empty wrapper), so cache keys get version-bumped when query logic changes. Exact-phrase stacking (`"a" AND "b" AND "c"`) reliably returns zero — use plain keyword queries.

More hard-won traps: `node --env-file` / `dotenv` do NOT override shell env (stale `~/.bashrc` key) — parse `.env` directly or use `override:true` with absolute path; never pass base64 through shell args (ARG_MAX) — build JSON bodies in node/fs; `pnpm [--dir] script -- args` loses args under tsx — call `node_modules/.bin/tsx` directly; tsx can hang post-script (esbuild service keeps loop alive) — kill by PID; never combine kill-patterns with literal target strings in one command; no unbounded foreground waits in tool commands.


- **LLM Council standard (2026-09-14):** advisor/reviewer rotation = Haiku-4.5-or-latest + GLM-5.3-or-latest-Flash + DeepSeek-v4.1-or-latest-Flash — always the latest version of each family, always the Flash/fast tier (user mandate 2026-09-14; ~$0.02/run); **Chairman = latest Claude Sonnet** (`anthropic/claude-sonnet-5` as of 2026-09-14) — quality gate. DeepSeek-v4.1-flash is a reasoning model: needs max_tokens >= 2500 or content comes back null. Council runner: `data/intel/council_2026-09-14_profile_first/council_run.cjs`.
- **Agent-dispatch nudge policy:** subagents stall in limbo sometimes — (1) always dispatch with an exact output path + REPORT-BACK contract; (2) if a dispatch stalls/cancels, re-dispatch via the Task tool with its `task_id` to CONTINUE the same session (resume, not restart); (3) if resume fails twice, recover from partial artifacts and finish inline; (4) never use bare `opencode --continue` (wrong-session incident 2026-09-11).

## Session continuity

- `data/intel/session_handover_2026-09-09.md` — full two-day handover report (timeline, loops, bridge content, critical path). Read together with this file.

Syntax check (no test suite exists):

```bash
pnpm exec esbuild harvest.ts --outfile=/dev/null   # repeat for any changed .ts
```

## Data format policy (per layer, not one format)

- **JSON** — machine payloads only (`payload.json`, `scored.json`, `candidates.json`)
- **NDJSON** — append-only run log (`data/index.jsonl`)
- **Markdown + self-contained HTML** — human report layer (`pnpm report`; HTML opens locally, zero infra; static Vercel deploy later needs no backend/Supabase — defer Supabase until multi-device history UI is actually needed)
- **SQLite/CSV** — consider only when trend-queries across >10 runs or spreadsheet export is demanded

## Intel layer

- `data/intel/` — human-distilled strategy documents (`intel_gadzhi_summit_day3.md`: micro-creator distribution model, operator playbook, VRE framing; `intel_gadzhi_summit_day4.md`: funnel-hacking method, upsell math, one-day cash machine, picks-and-shovels framing). Derived from recorded live streams (`downloads/day*/transcript_*.md` via `pnpm transcribe`). Full session-continuity doc: `data/intel/session_handover_2026-09-09.md`.
- An additional candidate class was proposed 2026-09-08 — pending a pricing-band decision before adding to candidates.json; proposed schema fields (`upsell_companion`, `funnel_type`) noted in day-4 intel. Full rationale kept in `data/intel/` (gitignored, not in this public repo).
- `data/intel/engine_thesis_handover.md` §10 has a fact-checked review of an external ("CCW") critique and a ranked 10x plan. No Phase 4 script exists yet — it's a spec, not shipped code. Real bug found there: Phase 2 generates template-clone candidates ("[X] Tracker" vs "[X] Ledger") that pass Jaccard dedup because they're genuinely different tokens — fix belongs in the Phase 2 prompt (diversity constraint), not in score.ts's dedup logic.

## Hard-won quirks

- **pnpm 12 settings home is `pnpm-workspace.yaml`**, not the `pnpm` field in package.json (silently ignored). `onlyBuiltDependencies: [esbuild]` lives there.
- `ERR_PNPM_IGNORED_BUILDS` for esbuild is **advisory** — tsx works anyway (verified via `pnpm exec tsx --version`).
- `packageManager` and `devEngines.packageManager` in package.json must stay aligned or corepack hard-fails with `ERR_PNPM_BAD_PM_VERSION`.
- All scripts are `.ts` run through tsx (`pnpm harvest` etc.). Do not reintroduce `.mjs` — it was deleted deliberately.
- Scripts load `.env` via dotenv with **`override: true`** — `~/.bashrc` exports a stale Kilo Code `OPENROUTER_API_KEY` that shadowed the real key (dotenv never overrides by default → silent 401 "User not found" from OpenRouter with a perfectly valid .env key). Keep override mode; do not remove. **2026-09-16 RCA:** the bashrc export was a hex-v-intel MANAGEMENT key (cannot make model calls — guaranteed broken auth in every shell-context process); commented out (backup /tmp/opencode/bashrc.bak-2026-09-16). Standing rule: OR keys live in project `.env` only, never exported in shell. `OPENROUTER_MANAGEMENT_KEY` (management, activity/keys reads only) now in `.env` — spend audit: `node /tmp/opencode/or_rca3.cjs`-style activity aggregation; glm-5.2 deviation (213 reqs/$4.33, 48% of account spend) ATTRIBUTED+FIXED 2026-09-16: stale project-config pins (`model: z-ai/glm-5.2` in hex-yt-intel/.opencode/opencode.json + web-agy1-worktree/.opencode/opencode.json) override the global 5.3-flash pin on `opencode run --dir <project>`; billing key = opencode global auth.json ($196, dashboard name "openrouter-KiloCode-VSCode-API-Key"); both configs patched to 5.3-flash (backups *.bak-2026-09-16), banner live-verified — full RCA: data/intel/or_spend_rca_2026-09-16.md. Standing rule: NEVER pin a different model in a project opencode.json without a cost note.

- **STT standard (locked 2026-09-14):** `openai/gpt-4o-transcribe` via OpenRouter audio/transcriptions is the default for ALL transcription — verified best for Egyptian Arabic dialect AND Egyptian-accented English (WhatsApp OGG tested clean). Fallback: `openai/whisper-large-v3-turbo` (turbo exists for cost, but gpt-4o-transcribe wins on dialects). `transcribe.ts` still defaults to whisper — pass the model override or update when productionizing.
- Models (verified 2026-09-08): `x-ai/grok-4-fast` is **deprecated** (404) → use `x-ai/grok-4.3`. Grok on OpenRouter has no live web access by default — grounding requires `plugins: [{ id: "web" }]` in the request body.
- `cachedFetch` refuses to cache error objects or empty arrays — 401s and LLM empty-grounding results would otherwise poison the 6h cache.

## Secrets

- `.env` holds all API keys; `.env`, `data/`, `ideabrowser_vault.json` are gitignored. Keep it that way.
- `HIKERAPI_API_KEY` — Instagram verification tier 1 in `creator_scan.ts` (paid, pay-per-request, ~$0.001/req, pay only for 200/403/404). **LIVE-VERIFIED 2026-09-14** (was "unverified" before): auth model = the dashboard "API key" is a dapi MANAGER key (`X-API-Key` header on `hikerapi.com/dapi/*`, manages tokens/promocodes — do NOT commit, it can rotate/delete tokens); the DATA API (`api.hikerapi.com`) wants a TOKEN via `x-access-key` header (or `?access_key=` param). Find the real token via `GET /dapi/users/token` with the manager key. Verified endpoints: `/v1/user/by/username?username=` (returns follower/media counts, is_private/is_verified/is_business, public_email, contact_phone_number, biography, external_url, category_name, city_name — NOTE: no `country` field) and `/v1/user/medias/chunk?user_id=<pk>` (returns `[[items...], end_cursor]`; items carry taken_at_ts, like_count, comment_count — feeds activityRecent + engagement). Full catalog + Swagger spec: `hikerapi.com/dapi/openapi.json` (manager API) and `api.instagrapi.com/openapi.json` (same data API without Cloudflare). Also exists: official `hikerapi-mcp` MCP server (107 tools, tools generated live from /openapi.json; config env: HIKERAPI_KEY as x-access-key, HIKERAPI_TAGS whitelist filter, HIKERAPI_TIMEOUT_MS) and `insto` CLI (OSINT workflows: /timeline posting cadence, /fans superfan ranking, /dossier Maltego export) — candidates for the creator-understanding pipeline later.
- Last verified engine status (2026-09-08, final): **all 5 OK** — Sonar (OpenRouter), Grok (grok-4.3 + web plugin), SerpAPI trends (free plan = 250 searches/mo), Exa, Brave. OpenRouter key validated via `GET /api/v1/auth/key`; SerpAPI via `serpapi.com/account`. First fully-green run: `data/run_2026-09-08T16-32-28-278Z/` (317 trends + grounded LLM payloads). Cache-hit behavior verified across consecutive runs.

## Pipeline discipline

Order is fixed: **harvest → GLM generates `candidates.json` → score**. Never reorder.

- `harvest.ts` `run()` fires exactly 5 sources: Sonar (OpenRouter), Grok (OpenRouter), SerpAPI trends, Exa, Brave. 
- `fetchSerpAdDensity()` and `fetchDecodo()` are exported from `harvest.ts` but **must NOT be called in `run()`** — they are per-candidate Phase 3 lookups consumed by `score.ts`.
- `score.ts` implements `Vs = (P*0.25) + (E*0.20) + (T*0.20) + (F*0.15) - (S*0.20)`, range -20..40. The saturation penalty is subtractive by design — do not revert to an additive-only formula.
- `score.ts --top=N` guards the SerpAPI budget (250/mo free): pre-ranks by P/E/T/F, runs live S-lookups (SerpAPI ad-density + Decodo evidence) only on the top N (default: all — always pass `--top` on the free plan).
- `score.ts` de-duplicates candidates (Jaccard token overlap > 0.85) **before** scoring.
- `data/cache/` is content-hash keyed, TTL 6h. To verify caching: run `pnpm harvest` twice within 6h — second run must log `cache hit:` lines.

## External services

- **Decodo = 3 separate products — do not conflate credentials:**
  1. **Residential proxy** (`gate.decodo.com:10001`, user:pass via `DECODO_RESIDENTIAL_*`) → used by `getinsight_id_br.ts` for raw HTML fetch + cheerio. Verified 2026-09-08: must use the **`https://` proxy scheme** (`--proxy https://gate.decodo.com:10001`); plain `http://` CONNECT is flaky/aborts. Session-suffix usernames (`user-session-x`) are rejected by this plan — use the plain username and retry instead.
  2. **Web Scraping API** (`scraper-api.decodo.com`, Basic auth via `DECODO_SCRAPING_API_AUTH`) → used by `harvest.ts` `fetchDecodo()`. Free tier is nearly exhausted — manual/Phase-3 invocation only, never in scheduled/repeated runs. Body must use `{ "url": ... }`, not `{ "query": ... }` (400 otherwise).
  3. **Fast Search API** (`DECODO_SEARCH_API_KEY`) → placeholder only, no function built; propose call shape before wiring into `harvest.ts`.
- **Bright Data** zone `yt_intel_prx1` is a **proxy zone** (port 33335, `brd-customer-...` user format), NOT a Scraping Browser/CDP zone. Do not attempt `connectOverCDP`/playwright against it.
- **ideabrowser.com — DEFERRED, Pro-tier gated.** Do not integrate or scrape. Decision 2026-09-08: Agent Connector = MCP + API key generated in logged-in dashboard, Hub data/MCP = Pro plan ($1499/yr); free plan = Business Coach connector only. Raw fetch is blocked by Vercel Security Checkpoint (HTTP 429 JS challenge — curl/cheerio get the shield page, 0 ideas). robots.txt allows `/database` but ToS §4 prohibits copy/redistribute. Revisit ONLY if harvest.ts output proves insufficient. Until then: manual occasional reads by user; `getinsight_id_br.ts` + Decodo residential stays in toolkit for other targets (Whop/Gumroad leaderboards) where no bot-challenge exists.
