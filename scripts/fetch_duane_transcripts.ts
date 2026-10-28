// scripts/fetch_duane_transcripts.ts
//
// Pulls YouTube auto-caption transcripts for the Duane (@retirearly500k59) corpus.
//
// WHY THIS EXISTS: the first 64 transcripts under
// data/db/samples/duane_retirearly500/transcripts/ were fetched by an untracked one-off
// script that no longer exists — the same failure mode youtube_format.ts documents in its
// header. This file is the committed, reusable source of truth for that fetch.
//
// Output per video, matching the existing 64 byte-for-byte in shape:
//   <id>.en.vtt      raw yt-dlp auto-caption track
//   <id>.txt         "### <id> — <title>" header + de-duplicated caption prose, wrapped
//   <id>.meta.json   { id, title, published_at, duration_sec }
//
// Usage:
//   pnpm exec tsx scripts/fetch_duane_transcripts.ts --tiers=A-highview,B-topical
//   pnpm exec tsx scripts/fetch_duane_transcripts.ts --ids=RrnEAi75xno,ftwSvkAoOFE
//   pnpm exec tsx scripts/fetch_duane_transcripts.ts --tiers=A-highview --limit=5 --dry-run
//   pnpm exec tsx scripts/fetch_duane_transcripts.ts --source=inventory --proxy=decodo
//
// --source=inventory: candidates = every channel video in channel_inventory_2026-09-26.json
//   with no <id>.txt (long-form AND Shorts), excluding titles containing "Gigi". Order =
//   fetch_priority_2026-09-26.json ids first, then remaining long-form, then Shorts.
// --proxy=decodo: route yt-dlp through the Decodo residential proxy, built from
//   DECODO_RESIDENTIAL_USER / DECODO_RESIDENTIAL_PASS / DECODO_RESIDENTIAL_GATEWAY in .env.
//   The proxy URL is never printed — commands are logged with it masked.
//
// Already-present ids are skipped, so the script is resumable: re-run it after a partial
// or interrupted pass and it picks up only what is still missing.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import dotenv from "dotenv";

dotenv.config({ override: true });

const SAMPLE_DIR = "data/db/samples/duane_retirearly500";
const OUT_DIR = path.join(SAMPLE_DIR, "transcripts");
const GAP_FILE = path.join(SAMPLE_DIR, "transcript_gap_2026-09-19.json");
const INVENTORY_FILE = path.join(SAMPLE_DIR, "channel_inventory_2026-09-26.json");
const PRIORITY_FILE = path.join(SAMPLE_DIR, "fetch_priority_2026-09-26.json");
const SLEEP_MS = 1500; // be a polite client; yt-dlp throttles hard otherwise
const MAX_ATTEMPTS = 3; // YouTube throttles transiently; retry the same call, never a fallback
const TAPI_BASE = "https://transcriptapi.com/api/v2";
const CREDIT_BUDGET = 100; // per T48: stop before exceeding 100 transcript credits

type TranscriptApiResult = {
  video_id?: string;
  language?: string;
  transcript: { text: string; start?: number; duration?: number }[] | string;
  length_seconds?: number | null;
  lengthText?: string | null;
  metadata?: { title?: string };
};

type Candidate = {
  id: string;
  title: string;
  published_at: string;
  duration_sec: number;
  views: number | null;
  tier: string;
};

type InvEntry = {
  id: string;
  title: string;
  date: string;
  secs: number;
  kind: string;
  has: boolean;
};

// Decodo residential proxy (https scheme required — plain http CONNECT is flaky/aborts).
// Built once from env; never logged. Mask in any printed command string.
let proxyUrl: string | undefined;
function proxyArgs(): string[] {
  if (!proxyUrl) return [];
  return ["--proxy", proxyUrl];
}
function maskProxy(s: string): string {
  if (!proxyUrl) return s;
  const proto = proxyUrl.indexOf("//");
  const at = proxyUrl.indexOf("@");
  if (proto >= 0 && at > proto) return s.replaceAll(proxyUrl, `${proxyUrl.slice(0, proto + 2)}***:***@${proxyUrl.slice(at + 1)}`);
  return s;
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

// yt-dlp auto-captions repeat each line across a rolling two-cue window and carry inline
// <timestamp><c> word-level markup. Strip the markup, then drop any line identical to a
// line already emitted in the recent window.
function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "")
      .replace(/<\/?c[^>]*>/g, "")
      .trim();
    if (!line) continue;
    if (line === "WEBVTT") continue;
    if (/^(Kind|Language):/.test(line)) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->/.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (lines.slice(-4).includes(line)) continue;
    lines.push(line);
  }
  // Re-flow into prose, wrapped near the width the existing 64 files use.
  const words = lines.join(" ").replace(/\s+/g, " ").trim().split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + w.length + 1 > 110) {
      out.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) out.push(cur);
  return out.join("\n");
}

// A transient YouTube throttle makes yt-dlp exit non-zero on a video that succeeds moments
// later (observed live 2026-09-19 on RrnEAi75xno). Retry the SAME call with backoff, then
// fail loud — never silently treat a throttle as "no captions exist".
function fetchCaptions(id: string): void {
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      execFileSync(
        "yt-dlp",
        [
          "--skip-download",
          "--write-auto-subs",
          "--sub-lang", "en",
          "--sub-format", "vtt",
          "--no-warnings",
          "-o", path.join(OUT_DIR, "%(id)s.%(ext)s"),
          ...proxyArgs(),
          `https://www.youtube.com/watch?v=${id}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
      );
      return;
    } catch (e: unknown) {
      const stderr = (e as { stderr?: Buffer })?.stderr?.toString().trim() ?? "";
      lastErr = stderr.split("\n").filter(Boolean).pop() ?? (e instanceof Error ? e.message.split("\n")[0] : String(e));
      if (attempt < MAX_ATTEMPTS) sleep(SLEEP_MS * 2 ** attempt);
    }
  }
  throw new Error(maskProxy(lastErr));
}

// --provider=transcriptapi: TranscriptAPI.com REST endpoint (docs 2026-09-25).
// GET {TAPI_BASE}/youtube/transcript?video_url=<id>&format=json&include_timestamp=true
// with `Authorization: Bearer <key>`. 1 credit per 200 (cached hits included), 0 on errors.
// Retryable: 408/429/503 (docs' retry strategy). 402 = out of credits -> stop the run.
// No VTT track exists on this path — <id>.en.vtt is skipped and noted in the meta.
class OutOfCreditsError extends Error {}

function segmentsToText(segments: { text: string }[]): string {
  const lines: string[] = [];
  for (const seg of segments) {
    const line = seg.text.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (lines.slice(-4).includes(line)) continue;
    lines.push(line);
  }
  const words = lines.join(" ").replace(/\s+/g, " ").trim().split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + w.length + 1 > 110) {
      out.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) out.push(cur);
  return out.join("\n");
}

// Returns the deduped, wrapped prose for one video. Throws OutOfCreditsError on 402
// so the caller can stop the whole run without burning further attempts.
async function fetchTranscriptApiText(id: string): Promise<string> {
  const key = process.env.TRANSCRIPTAPI_API_KEY;
  if (!key) throw new Error("TRANSCRIPTAPI_API_KEY missing from .env");
  const url = `${TAPI_BASE}/youtube/transcript?video_url=${encodeURIComponent(id)}&format=json&include_timestamp=true`;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 402) throw new OutOfCreditsError("HTTP 402 — out of credits");
      if (res.status === 200) {
        const data = JSON.parse(await res.text()) as TranscriptApiResult;
        const segs = Array.isArray(data.transcript) ? data.transcript : [];
        const prose = segmentsToText(segs);
        if (!prose) throw new Error("empty transcript returned");
        return prose;
      }
      if (res.status === 404) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        throw new Error(`HTTP 404 — ${body.detail ?? "no transcript available"}`);
      }
      // 408/429/503 are retryable per docs; anything else: report and stop retrying.
      lastErr = `HTTP ${res.status}`;
      if (![408, 429, 503].includes(res.status)) break;
    } catch (e: unknown) {
      if (e instanceof OutOfCreditsError) throw e;
      if (e instanceof SyntaxError) throw new Error("malformed JSON response");
      lastErr = e instanceof Error ? e.message.split("\n")[0] : String(e);
    }
    if (attempt < MAX_ATTEMPTS) sleep(SLEEP_MS * 2 ** attempt);
  }
  throw new Error(lastErr);
}

function buildInventoryCandidates(): Candidate[] {
  if (!fs.existsSync(INVENTORY_FILE)) {
    throw new Error(`missing ${INVENTORY_FILE}`);
  }
  const inv: InvEntry[] = JSON.parse(fs.readFileSync(INVENTORY_FILE, "utf8"));
  const priority: { id: string }[] = fs.existsSync(PRIORITY_FILE)
    ? JSON.parse(fs.readFileSync(PRIORITY_FILE, "utf8"))
    : [];

  const already = new Set(
    fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".txt")).map((f) => f.replace(/\.txt$/, "")),
  );
  const toFetch = inv.filter(
    (v) => v.has === false && !already.has(v.id) && !/gigi/i.test(v.title),
  );

  const rank = new Map(priority.map((p, i) => [p.id, i]));
  const isShort = (v: InvEntry) => v.kind !== "long-form";
  const sorted = [...toFetch].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : priority.length + (isShort(a) ? 1 : 0);
    const rb = rank.has(b.id) ? rank.get(b.id)! : priority.length + (isShort(b) ? 1 : 0);
    return ra - rb;
  });
  return sorted.map((v) => ({
    id: v.id,
    title: v.title,
    published_at: v.date,
    duration_sec: v.secs,
    views: null,
    tier: v.kind,
  }));
}

async function main() {
  const source = arg("source") ?? "gap";
  if (arg("proxy")) {
    const user = process.env.DECODO_RESIDENTIAL_USER;
    const pass = process.env.DECODO_RESIDENTIAL_PASS;
    const gateway = process.env.DECODO_RESIDENTIAL_GATEWAY;
    if (!user || !pass || !gateway) {
      throw new Error("proxy=decodo requires DECODO_RESIDENTIAL_USER/PASS/GATEWAY in .env");
    }
    proxyUrl = `https://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${gateway}`;
  }

  let all: Candidate[];
  if (source === "inventory") {
    all = buildInventoryCandidates();
  } else {
    if (!fs.existsSync(GAP_FILE)) {
      throw new Error(`missing ${GAP_FILE} — run the catalog cross-reference first`);
    }
    const gap = JSON.parse(fs.readFileSync(GAP_FILE, "utf8"));
    all = gap.candidates;
  }

  const idsArg = arg("ids");
  const tiers = (arg("tiers") ?? "A-highview,B-topical").split(",");
  const limit = Number(arg("limit") ?? Infinity);
  const dryRun = hasFlag("dry-run");

  // --ids keeps the caller's order, so a priority-ranked list is fetched most-important first.
  const byId = new Map(all.map((c) => [c.id, c]));
  let picked = idsArg
    ? idsArg.split(",").map((id) => byId.get(id)).filter((c): c is Candidate => c !== undefined)
    : source === "inventory"
      ? all
      : all.filter((c) => tiers.includes(c.tier));

  const already = new Set(
    fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".txt")).map((f) => f.replace(/\.txt$/, "")),
  );
  const skipped = picked.filter((c) => already.has(c.id)).length;
  picked = picked.filter((c) => !already.has(c.id)).slice(0, limit);

  console.log(`candidates: ${picked.length} to fetch (${skipped} already present)`);
  if (dryRun) {
    picked.forEach((c) => console.log(`  [${c.tier}] ${c.id}  ${c.title}`));
    return;
  }

  let ok = 0;
  let credits = 0;
  const failed: { id: string; reason: string }[] = [];

  const provider = arg("provider") ?? "ytdlp";
  if (provider !== "ytdlp" && provider !== "transcriptapi") {
    throw new Error(`unknown provider: ${provider} (ytdlp | transcriptapi)`);
  }

  for (const [i, c] of picked.entries()) {
    const tag = `[${i + 1}/${picked.length}] ${c.id}`;
    if (provider === "transcriptapi" && credits >= CREDIT_BUDGET) {
      console.log(`${tag} SKIP — credit budget ${CREDIT_BUDGET} reached, stopping`);
      break;
    }
    try {
      let body: string;
      if (provider === "transcriptapi") {
        body = await fetchTranscriptApiText(c.id);
        credits++;
      } else {
        fetchCaptions(c.id);

        const vttPath = path.join(OUT_DIR, `${c.id}.en.vtt`);
        if (!fs.existsSync(vttPath)) {
          failed.push({ id: c.id, reason: "no en auto-captions published" });
          console.log(`${tag} SKIP — no captions`);
          continue;
        }
        body = vttToText(fs.readFileSync(vttPath, "utf8"));
      }

      const title = c.title.replace(/\*/g, "").trim();
      fs.writeFileSync(path.join(OUT_DIR, `${c.id}.txt`), `### ${c.id} — ${title}\n${body}\n`);
      fs.writeFileSync(
        path.join(OUT_DIR, `${c.id}.meta.json`),
        JSON.stringify(
          provider === "transcriptapi"
            ? {
                id: c.id,
                title: c.title,
                published_at: c.published_at,
                duration_sec: c.duration_sec,
                provider: "transcriptapi",
                en_vtt: "skipped — API provides no VTT track",
              }
            : { id: c.id, title: c.title, published_at: c.published_at, duration_sec: c.duration_sec },
          null,
          1,
        ) + "\n",
      );
      ok++;
      console.log(`${tag} ok — ${title.slice(0, 60)}`);
    } catch (e: unknown) {
      if (e instanceof OutOfCreditsError) {
        console.log(`${tag} STOP — ${e.message}`);
        break;
      }
      const reason = maskProxy(e instanceof Error ? e.message.split("\n")[0] : String(e));
      failed.push({ id: c.id, reason });
      console.log(`${tag} FAIL — ${reason}`);
    }
    sleep(SLEEP_MS);
  }

  console.log(`\ndone: ${ok} fetched, ${failed.length} failed/skipped`);
  if (provider === "transcriptapi") console.log(`credits used: ${credits} / budget ${CREDIT_BUDGET}`);
  if (failed.length) failed.forEach((f) => console.log(`  ${f.id}: ${f.reason}`));
}

main();