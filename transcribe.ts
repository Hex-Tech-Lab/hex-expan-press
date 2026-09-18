import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { GLOBAL, expandHome } from "@payments/settings_registry";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ override: true, path: path.join(ROOT, GLOBAL.paths.env_file) });
const HOME = process.env.HOME ?? "";

// STT/ffmpeg tunables live in the settings registry (data/settings/transcribe.json; STT endpoint
// + tool paths in global.json). Inline defaults mirror the committed registry so standalone runs
// (missing/unreadable settings) behave identically. ENV/CLI overrides keep precedence:
// WHISPER_MODEL env > registry stt.model; --chunk= CLI > registry chunk_seconds.
const DEFAULT_TRANSCRIBE = {
  stt: { model: "openai/gpt-4o-transcribe", fallback: "openai/whisper-large-v3-turbo", audio_format: "mp3", response_format: "verbose_json" },
  chunk_seconds: 600,
  live_margin_seconds: 90,
  final_tail_min_s: 5,
  probe: { retries: 3, sleep_ms: 3000 },
  timeouts: { ffmpeg_ms: 180000, ffprobe_ms: 60000, stt_ms: 300000, error_backoff_ms: 30000 },
  watch_poll_ms: 600000,
  audio: { channels: 1, sample_rate: 16000, codec: "libmp3lame", bitrate: "64k" },
  default_input: "downloads/gadzhi_live_video.mp4",
  transcript_title: "Gadzhi Live Transcript",
};

function loadTranscribeSettings(): typeof DEFAULT_TRANSCRIBE {
  const candidates = [
    path.join(process.cwd(), "data", "settings", "transcribe.json"),
    path.join(ROOT, "data", "settings", "transcribe.json"),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<typeof DEFAULT_TRANSCRIBE>;
      return {
        ...DEFAULT_TRANSCRIBE,
        ...raw,
        stt: { ...DEFAULT_TRANSCRIBE.stt, ...raw.stt },
        probe: { ...DEFAULT_TRANSCRIBE.probe, ...raw.probe },
        timeouts: { ...DEFAULT_TRANSCRIBE.timeouts, ...raw.timeouts },
        audio: { ...DEFAULT_TRANSCRIBE.audio, ...raw.audio },
      };
    } catch {
      // unreadable/invalid -> next candidate, else inline defaults
    }
  }
  console.error("[transcribe] data/settings/transcribe.json missing/unreadable — inline fallbacks in effect");
  return DEFAULT_TRANSCRIBE;
}

const T = loadTranscribeSettings();

const FFMPEG = expandHome(GLOBAL.tool_paths.ffmpeg, HOME);
const FFPROBE = expandHome(GLOBAL.tool_paths.ffprobe, HOME);
const STT_ENDPOINT = GLOBAL.endpoints.openrouter_stt;
const DL = path.join(ROOT, "downloads");
const args = process.argv.slice(2).filter((a) => a !== "--");
const fileArg = args.find((a) => a.startsWith("--file="));
const PART = fileArg
  ? fileArg.split("=").slice(1).join("=")
  : existsSync(path.join(ROOT, T.default_input))
    ? path.join(ROOT, T.default_input)
    : path.join(DL, "gadzhi_live_video.f140.mp4.part");
const BASE = path.basename(PART).replace(/\.(mp4|part|m4a).*$/, "");
const STATE = path.join(DL, `transcribe_state_${BASE}.json`);
const OUT = path.join(DL, `transcript_${BASE}.md`);
const DONE = path.join(DL, `DONE_${BASE}`);
// STT model: env override WHISPER_MODEL > registry stt.model; fallback model from stt.fallback
// (locked STT standard 2026-09-14: gpt-4o-transcribe primary, whisper-large-v3-turbo fallback).
const MODEL = process.env.WHISPER_MODEL || T.stt.model;
const FALLBACK_MODEL = T.stt.fallback;
const CHUNK = Number(args.find((a) => a.startsWith("--chunk="))?.split("=")[1]) || T.chunk_seconds;
const MARGIN = T.live_margin_seconds;

function durationOf(file: string): number {
  let last = 0;
  for (let attempt = 0; attempt < T.probe.retries; attempt++) {
    try {
      const out = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: T.timeouts.ffprobe_ms }).toString().trim();
      last = Number(out) || 0;
      if (last > 0) return last;
    } catch {
      last = 0;
    }
    execFileSync("sleep", [String(T.probe.sleep_ms / 1000)]);
  }
  throw new Error(`ffprobe could not read duration of ${file} after ${T.probe.retries} tries`);
}

function makeChunk(start: number, dur: number, out: string): void {
  execFileSync(
    FFMPEG,
    [
      "-y", "-loglevel", "error", "-ss", String(start), "-i", PART, "-t", String(dur),
      "-ac", String(T.audio.channels), "-ar", String(T.audio.sample_rate),
      "-c:a", T.audio.codec, "-b:a", T.audio.bitrate, out,
    ],
    { timeout: T.timeouts.ffmpeg_ms },
  );
}

async function sttRequest(file: string, model: string): Promise<{ text: string; segments?: { start: number; end: number; text: string }[] }> {
  const b64 = readFileSync(file).toString("base64");
  const res = await fetch(STT_ENDPOINT, {
    method: "POST",
    headers: {
      "X-Title": "hex-expan",
      "HTTP-Referer": "https://github.com/TechHypeXP/hex-expan",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input_audio: { data: b64, format: T.stt.audio_format },
      response_format: T.stt.response_format,
    }),
    signal: AbortSignal.timeout(T.timeouts.stt_ms),
  });
  if (!res.ok) throw new Error(`transcribe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { text?: string; segments?: { start: number; end: number; text: string }[] };
  return { text: j.text ?? "", segments: j.segments };
}

async function transcribeFile(file: string): Promise<{ text: string; segments?: { start: number; end: number; text: string }[] }> {
  try {
    return await sttRequest(file, MODEL);
  } catch (err) {
    if (!FALLBACK_MODEL || FALLBACK_MODEL === MODEL) throw err;
    console.error(`primary STT (${MODEL}) failed: ${String((err as Error).message).slice(0, 120)} — retrying with fallback ${FALLBACK_MODEL}`);
    return await sttRequest(file, FALLBACK_MODEL);
  }
}

const ts = (sec: number): string => {
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  return `${h}:${m}`;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const watch = process.argv.includes("--watch");
  console.log(`==> source: ${PART}`);
  if (!existsSync(PART)) throw new Error(`input file not found: ${PART}`);
  if (!existsSync(STATE)) writeFileSync(STATE, JSON.stringify({ lastSec: 0 }));
  const state = JSON.parse(readFileSync(STATE, "utf-8")) as { lastSec: number };
  if (!existsSync(OUT)) writeFileSync(OUT, `# ${T.transcript_title}\n\n`);

  let finished = false;
  while (!finished) {
    const dur = durationOf(PART);
    const target = existsSync(DONE) ? dur : Math.max(0, dur - MARGIN);
    while (state.lastSec + CHUNK <= target) {
      const start = state.lastSec;
        const tmp = path.join(DL, `.chunk_${start}_${process.pid}.mp3`);
      console.log(`[${ts(start)}] chunking + transcribing...`);
      try {
        makeChunk(start, CHUNK, tmp);
        const r = await transcribeFile(tmp);
        const block =
          r.segments && r.segments.length > 0
            ? r.segments.map((s) => `- [${ts(start + s.start)}] ${s.text.trim()}`).join("\n")
            : r.text.trim();
        appendFileSync(OUT, `\n## [${ts(start)}]\n${block}\n`);
        state.lastSec = start + CHUNK;
        writeFileSync(STATE, JSON.stringify(state));
        console.log(`[${ts(start)}] transcribed, ${r.text.length} chars, ${r.segments?.length ?? 0} segments`);
      } catch (err) {
        console.error(`chunk@${start} failed: ${String((err as Error).message).slice(0, 150)}`);
        await sleep(T.timeouts.error_backoff_ms);
      } finally {
        if (existsSync(tmp)) execFileSync("rm", ["-f", tmp]);
      }
    }
    if (!watch) break;
    if (existsSync(DONE)) {
      const finalDur = durationOf(PART);
      if (finalDur - state.lastSec > T.final_tail_min_s) {
        const tmp = path.join(DL, `.chunk_final_${process.pid}.mp3`);
        try {
          makeChunk(state.lastSec, finalDur - state.lastSec, tmp);
          const r = await transcribeFile(tmp);
          const block =
            r.segments && r.segments.length > 0
              ? r.segments.map((s) => `- [${ts(state.lastSec + s.start)}] ${s.text.trim()}`).join("\n")
              : r.text.trim();
          appendFileSync(OUT, `\n## [${ts(state.lastSec)}]\n${block}\n`);
          state.lastSec = finalDur;
          writeFileSync(STATE, JSON.stringify(state));
        } catch (err) {
          console.error(`final chunk failed: ${String((err as Error).message).slice(0, 150)}`);
        }
      }
      console.log("stream ended, transcript complete");
      finished = true;
      break;
    }
    await sleep(T.watch_poll_ms);
  }
}

main().catch((err) => {
  console.error("transcriber failed:", err?.message || err);
  process.exit(1);
});
