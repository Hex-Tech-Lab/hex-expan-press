import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import * as pdfjs from "../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs";
import { expandHome, GLOBAL } from "../payments/src/settings_registry";
import {
  buildSpreadAccessibleModel,
  extractStructuredPageBlocks,
  type AccessibleBlock,
  type PdfTextItemLike,
  type PreviewAudioManifest,
  type PreviewAudioPageTrack,
} from "../web/src/components/storefront/book-previewer-text";
import {
  assemblePagePcm,
  decodeAudioToNativePcm,
  encodeLoudnormMp3,
  formatChunkForSpeech,
  isMetadataBookPage,
  NATIVE_SAMPLE_RATE,
  parsePageSelection,
  probeDurationMs,
  resolveVoiceFromNarrationSettings,
  trimSilencePcm,
} from "./narrate_book_preview_audio";

export {
  assemblePagePcm,
  formatChunkForSpeech,
  isMetadataBookPage,
  parsePageSelection,
  resolveVoiceFromNarrationSettings,
  trimSilencePcm,
};

const MAX_AUDIO_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export interface SpeechChunkPlan {
  id: string;
  pageIndex: number;
  blockIndex: number;
  blockKind: AccessibleBlock["kind"];
  text: string;
  spokenText: string;
}

function resolveEnvPath(explicitPath: string | undefined, repoRoot: string): string | null {
  const candidates: string[] = [];
  if (explicitPath) candidates.push(explicitPath);
  candidates.push(path.join(repoRoot, GLOBAL.paths.env_file));
  try {
    const commonGitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (commonGitDir) {
      const sharedRoot = path.dirname(commonGitDir);
      if (sharedRoot !== repoRoot) candidates.push(path.join(sharedRoot, GLOBAL.paths.env_file));
    }
  } catch (err) {
    console.warn("[vcp] git common-dir discovery skipped:", err instanceof Error ? err.message : String(err));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function fetchGetWithRetry(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new Error(`fetchGetWithRetry only permits GET/HEAD, got ${method}`);
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { ...init, method, signal: AbortSignal.timeout(timeoutMs) });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await res.body?.cancel().catch((cancelErr: unknown) => {
          console.warn("[vcp] retry response body cancel warning:", cancelErr instanceof Error ? cancelErr.message : String(cancelErr));
        });
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000 * (attempt + 1), 10000)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      console.warn(`[vcp] GET attempt ${attempt + 1}/6 failed:`, err instanceof Error ? err.message : String(err));
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000 * (attempt + 1), 10000)));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function readBoundedBytes(res: Response, maxBytes: number): Promise<Buffer> {
  const rawLen = res.headers.get("content-length");
  if (rawLen) {
    const parsedLen = Number.parseInt(rawLen, 10);
    if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
      throw new Error(`Audio response exceeds cap (${parsedLen} > ${maxBytes})`);
    }
  }
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("Audio response has no readable body stream");
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Audio stream exceeded ${maxBytes} byte cap`);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts, total);
}

async function synthesizeVcpChunk(
  apiBase: string,
  apiKey: string,
  voiceId: string,
  model: string,
  spokenText: string,
  outWavPath: string,
  opts: { poll_wait_seconds: number; max_poll_attempts: number; request_timeout_ms: number },
): Promise<{ billedUnits?: number }> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const submitRes = await fetch(`${apiBase}/v1/speech`, {
    method: "POST",
    headers,
    body: JSON.stringify({ voice: voiceId, model, text: spokenText }),
    signal: AbortSignal.timeout(opts.request_timeout_ms),
  });
  const submitBody = await submitRes.text();
  if (!submitRes.ok) {
    throw new Error(`VCP POST /v1/speech failed (${submitRes.status}): ${submitBody.slice(0, 300)}`);
  }
  const submitted = JSON.parse(submitBody) as { id?: string };
  const jobId = submitted.id;
  if (!jobId) {
    throw new Error(`VCP POST /v1/speech missing job id: ${submitBody.slice(0, 300)}`);
  }

  for (let attempt = 1; attempt <= opts.max_poll_attempts; attempt++) {
    const pollRes = await fetchGetWithRetry(
      `${apiBase}/v1/jobs/${encodeURIComponent(jobId)}?wait=${opts.poll_wait_seconds}`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
      opts.request_timeout_ms,
    );
    const pollText = await pollRes.text();
    if (!pollRes.ok) {
      throw new Error(`VCP GET /v1/jobs/${jobId} failed (${pollRes.status}): ${pollText.slice(0, 300)}`);
    }
    const job = JSON.parse(pollText) as {
      status?: string;
      error?: unknown;
      tokens_charged?: number;
      result?: { audio_url?: string; download_url?: string };
    };
    if (job.status === "failed" || job.status === "error") {
      throw new Error(`VCP job ${jobId} failed: ${JSON.stringify(job.error)}`);
    }
    const audioUrl = job.result?.audio_url ?? job.result?.download_url;
    if (job.status === "succeeded" && audioUrl) {
      const audioRes = await fetchGetWithRetry(audioUrl, { method: "GET" }, opts.request_timeout_ms);
      if (!audioRes.ok) {
        throw new Error(`VCP audio download failed (${audioRes.status}) for job ${jobId}`);
      }
      const bytes = await readBoundedBytes(audioRes, MAX_AUDIO_DOWNLOAD_BYTES);
      writeFileSync(outWavPath, bytes);
      return { billedUnits: job.tokens_charged };
    }
  }
  throw new Error(`VCP job ${jobId} timed out after ${opts.max_poll_attempts} polls`);
}

async function runPool<T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  staggerMs: number,
  worker: (item: T, idx: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let lastStartAt = 0;
  const runWorker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const now = Date.now();
      const waitMs = Math.max(0, lastStartAt + staggerMs - now);
      lastStartAt = now + waitMs;
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      await worker(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
}

function getArg(flag: string): string | undefined {
  const prefix = `${flag}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const bookArg = getArg("--book") ?? "books/sample_the_quiet_workshop.json";
  const bookPath = path.isAbsolute(bookArg) ? bookArg : path.join(repoRoot, bookArg);
  const book = JSON.parse(readFileSync(bookPath, "utf8")) as {
    id: string;
    author?: string;
    preview_pdf?: string | null;
    preview_pages?: string;
  };
  if (!book.preview_pdf) throw new Error(`Book ${book.id} has no preview_pdf`);

  const narration = GLOBAL.voice_narration;
  const { voiceId, voiceName } = resolveVoiceFromNarrationSettings(narration, {
    preset: getArg("--voice-preset"),
    voiceId: getArg("--voice"),
    voiceName: getArg("--voice-name"),
  });
  const model = getArg("--model") ?? narration.model;
  const concurrency = Math.min(Math.max(Number.parseInt(getArg("--concurrency") ?? "3", 10) || 3, 1), 3);
  const assembleOnly = hasFlag("--assemble-only");
  const force = hasFlag("--force");
  const dryRun = hasFlag("--dry-run");

  const home = process.env.HOME ?? "";
  const ffmpegBin = expandHome(GLOBAL.tool_paths.ffmpeg, home);
  const ffprobeBin = expandHome(GLOBAL.tool_paths.ffprobe, home);

  const pdfDiskPath = path.join(repoRoot, "web", "public", book.preview_pdf.replace(/^\//, ""));
  const pdfData = new Uint8Array(readFileSync(pdfDiskPath));
  const doc = await pdfjs.getDocument({ data: pdfData, verbosity: 0 }).promise;
  const pageCount = Math.min(doc.numPages, GLOBAL.book_preview.max_preview_pages);
  const selectedPages = parsePageSelection(getArg("--pages"), pageCount);

  const pageBlocks: AccessibleBlock[][] = [];
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pageBlocks.push(
      extractStructuredPageBlocks(tc.items as PdfTextItemLike[], GLOBAL.book_preview.text_structure, viewport.height),
    );
  }
  await doc.destroy();

  const bookPageLabels = (book.preview_pages ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);

  const pagePlans: Array<{
    pageIndex: number;
    pdfPageNumber: number;
    bookPageLabel?: string;
    chunks: SpeechChunkPlan[];
  }> = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const isMetadataPage = isMetadataBookPage(pageBlocks[pageIndex] ?? []);
    const modelForPage = buildSpreadAccessibleModel([pageIndex], pageBlocks, GLOBAL.book_preview.read_aloud.max_chunk_chars);
    const pageGroup = modelForPage.pages.at(0);
    const chunks: SpeechChunkPlan[] = [];
    if (pageGroup) {
      for (const blockGroup of pageGroup.blocks) {
        for (const chunk of blockGroup.chunks) {
          chunks.push({
            id: chunk.id,
            pageIndex,
            blockIndex: chunk.blockIndex,
            blockKind: blockGroup.block.kind,
            text: chunk.text,
            spokenText: formatChunkForSpeech(chunk.text, blockGroup.block.kind, {
              isMetadataPage,
              authorName: book.author,
            }),
          });
        }
      }
    }
    pagePlans.push({
      pageIndex,
      pdfPageNumber: pageIndex + 1,
      ...(bookPageLabels[pageIndex] ? { bookPageLabel: bookPageLabels[pageIndex] } : {}),
      chunks,
    });
  }

  if (dryRun) {
    for (const plan of pagePlans) {
      if (!selectedPages.has(plan.pdfPageNumber)) continue;
      console.log(`Page ${plan.pdfPageNumber} (label=${plan.bookPageLabel ?? "-"}) -> ${plan.chunks.length} chunks`);
      for (const chunk of plan.chunks) {
        console.log(`  ${chunk.id} | ${JSON.stringify(chunk.text)} -> ${JSON.stringify(chunk.spokenText)}`);
      }
    }
    return;
  }

  const cacheDir = path.join(repoRoot, GLOBAL.paths.cache_dir, "vcp_narration", book.id, voiceId);
  const audioPublicDir = path.join(repoRoot, "web", "public", GLOBAL.storefront.audio_base_path.replace(/^\//, ""), book.id);
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(audioPublicDir, { recursive: true });

  const chunkCachePath = (chunk: SpeechChunkPlan) => {
    const hash = createHash("sha256").update(`${voiceId}|${model}|${chunk.spokenText}`).digest("hex").slice(0, 16);
    return {
      wav: path.join(cacheDir, `${chunk.id}_${hash}.wav`),
      meta: path.join(cacheDir, `${chunk.id}_${hash}.json`),
    };
  };

  const pendingToSynth = pagePlans
    .filter((plan) => selectedPages.has(plan.pdfPageNumber))
    .flatMap((plan) => plan.chunks)
    .filter((chunk) => force || !existsSync(chunkCachePath(chunk).wav));

  let apiKey = "";
  let usedBefore: number | undefined;
  if (!assembleOnly && pendingToSynth.length > 0) {
    const envPath = resolveEnvPath(getArg("--env"), repoRoot);
    if (envPath) dotenv.config({ path: envPath, override: true });
    apiKey = process.env[narration.env_key_name] ?? "";
    if (!apiKey) {
      throw new Error(`Missing ${narration.env_key_name} in environment or .env`);
    }
    const usageRes = await fetch(`${GLOBAL.endpoints.voicecreator_api}/v1/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(narration.request_timeout_ms),
    });
    if (usageRes.ok) {
      const usageBody = (await usageRes.json()) as { tokens_used?: number; allowance_remaining?: number };
      usedBefore = usageBody.tokens_used;
      const remBefore = usageBody.allowance_remaining;
      console.log(`[vcp] Allowance before: used=${usedBefore ?? "?"}, remaining=${remBefore ?? "?"}`);
    }

    console.log(`[vcp] Synthesizing ${pendingToSynth.length} chunks (concurrency=${concurrency}, voice=${voiceName})...`);
    await runPool(pendingToSynth, concurrency, 1100, async (chunk, idx) => {
      const paths = chunkCachePath(chunk);
      const res = await synthesizeVcpChunk(
        GLOBAL.endpoints.voicecreator_api,
        apiKey,
        voiceId,
        model,
        chunk.spokenText,
        paths.wav,
        narration,
      );
      writeFileSync(paths.meta, JSON.stringify({ id: chunk.id, tokensCharged: res.billedUnits ?? null }, null, 2));
      const chargedCount = res.billedUnits;
      console.log(`[vcp] [${idx + 1}/${pendingToSynth.length}] ${chunk.id} (${chargedCount ?? "?"} units)`);
    });

    const usageAfterRes = await fetch(`${GLOBAL.endpoints.voicecreator_api}/v1/usage`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(narration.request_timeout_ms),
    });
    if (usageAfterRes.ok) {
      const usageAfter = (await usageAfterRes.json()) as { tokens_used?: number; allowance_remaining?: number };
      const usedAfter = usageAfter.tokens_used;
      const remAfter = usageAfter.allowance_remaining;
      const delta =
        typeof usedAfter === "number" && typeof usedBefore === "number" ? usedAfter - usedBefore : undefined;
      console.log(`[vcp] Allowance after: used=${usedAfter ?? "?"}, delta=${delta ?? "?"}, remaining=${remAfter ?? "?"}`);
    }
  } else {
    console.log(`[vcp] 0 new chunks to synthesize (cached=${pagePlans.flatMap((plan) => plan.chunks).length}, assembleOnly=${assembleOnly}).`);
  }

  const pagesManifest: Record<string, PreviewAudioPageTrack> = {};
  for (const plan of pagePlans) {
    const allCached = plan.chunks.length > 0 && plan.chunks.every((chunk) => existsSync(chunkCachePath(chunk).wav));
    if (!allCached) {
      console.log(`[assemble] Skipping page ${plan.pdfPageNumber} (incomplete cache)`);
      continue;
    }
    const entries = plan.chunks.map((chunk) => {
      const paths = chunkCachePath(chunk);
      const rawPcm = decodeAudioToNativePcm(ffmpegBin, paths.wav);
      const trimmedPcm = trimSilencePcm(rawPcm, NATIVE_SAMPLE_RATE, {
        thresholdDb: narration.silence_threshold_db,
        padStartMs: narration.silence_pad_start_ms,
        padEndMs: narration.silence_pad_end_ms,
      });
      let chargedUnits: number | undefined;
      if (existsSync(paths.meta)) {
        const meta = JSON.parse(readFileSync(paths.meta, "utf8")) as { tokensCharged?: number | null };
        if (typeof meta.tokensCharged === "number") chargedUnits = meta.tokensCharged;
      }
      return {
        id: chunk.id,
        blockIndex: chunk.blockIndex,
        text: chunk.text,
        spokenText: chunk.spokenText,
        tokensCharged: chargedUnits,
        pcm: trimmedPcm,
      };
    });

    const assembled = assemblePagePcm(entries, {
      sampleRate: NATIVE_SAMPLE_RATE,
      pageLeadMs: narration.page_lead_ms,
      pageTailMs: narration.page_tail_ms,
      sentenceGapMs: narration.sentence_gap_ms,
      paragraphGapMs: narration.paragraph_gap_ms,
    });

    const fileName = `page-${String(plan.pdfPageNumber).padStart(2, "0")}.mp3`;
    const outMp3Path = path.join(audioPublicDir, fileName);
    encodeLoudnormMp3(ffmpegBin, assembled.pcm, outMp3Path, {
      targetLufs: narration.loudnorm_lufs,
      sampleRateHz: narration.sample_rate_hz,
      bitrateKbps: narration.mp3_bitrate_kbps,
    });
    const durationMs = probeDurationMs(ffprobeBin, outMp3Path, assembled.rawDurationMs);
    const audioUrl = `${GLOBAL.storefront.audio_base_path}/${book.id}/${fileName}`;

    pagesManifest[String(plan.pdfPageNumber)] = {
      pageIndex: plan.pageIndex,
      pdfPageNumber: plan.pdfPageNumber,
      ...(plan.bookPageLabel ? { bookPageLabel: plan.bookPageLabel } : {}),
      audioUrl,
      durationMs,
      chunks: assembled.chunks,
    };
    console.log(`[assemble] Wrote ${fileName} (${durationMs} ms, ${assembled.chunks.length} chunks)`);
  }

  const manifest: PreviewAudioManifest = {
    version: 1,
    bookId: book.id,
    voiceId,
    voiceName,
    model,
    sampleRateHz: narration.sample_rate_hz,
    loudnormLufs: narration.loudnorm_lufs,
    generatedAt: new Date().toISOString(),
    pages: pagesManifest,
  };
  const timingsPath = path.join(audioPublicDir, "timings.json");
  writeFileSync(timingsPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[assemble] Wrote ${timingsPath} (${Object.keys(pagesManifest).length} pages)`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error("[narrate_book_preview] Fatal error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
