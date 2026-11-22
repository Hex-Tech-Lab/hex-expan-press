import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import * as pdfjs from "../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs";
import { expandHome, GLOBAL, VOICE_NARRATION_LIMITS } from "../payments/src/settings_registry";
import {
  buildSpreadAccessibleModel,
  extractStructuredPageBlocks,
  type AccessibleBlock,
  type PdfTextItemLike,
  type PreviewAudioManifest,
  type PreviewAudioPageTrack,
} from "../web/src/components/storefront/book-previewer-text";
import {
  applyNarrationLexicon,
  assemblePagePcm,
  assertSelectedPagesCached,
  buildChunkDecodeFilter,
  decodeAudioToNativePcm,
  encodeLoudnormOpus,
  formatChunkForSpeech,
  isMetadataBookPage,
  NATIVE_SAMPLE_RATE,
  OPUS_SAMPLE_RATE_HZ,
  parseChunkPrefixes,
  parsePageSelection,
  probeDurationMs,
  replaceWholeTermInsensitive,
  resolveTempoForVoice,
  resolveVoiceFromNarrationSettings,
  selectPendingChunksToSynth,
  trimSilencePcm,
} from "./narrate_book_preview_audio";
import {
  acquireNarrationLock,
  dedupeChunksByCachePath,
  fetchGetWithRetry,
  isValidWavFile,
  MAX_AUDIO_DOWNLOAD_BYTES,
  MIN_WAV_HEADER_BYTES,
  readBoundedBytes,
  runPool,
  writeAudioBytesAtomically,
  type NarrationLock,
} from "./narrate_book_preview_cache";

export {
  acquireNarrationLock,
  applyNarrationLexicon,
  assemblePagePcm,
  assertSelectedPagesCached,
  buildChunkDecodeFilter,
  dedupeChunksByCachePath,
  formatChunkForSpeech,
  isMetadataBookPage,
  isValidWavFile,
  parsePageSelection,
  replaceWholeTermInsensitive,
  resolveTempoForVoice,
  resolveVoiceFromNarrationSettings,
  selectPendingChunksToSynth,
  trimSilencePcm,
  type NarrationLock,
};

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

export async function synthesizeVcpChunk(
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
      if (
        bytes.length < MIN_WAV_HEADER_BYTES ||
        bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
        bytes.subarray(8, 12).toString("ascii") !== "WAVE"
      ) {
        throw new Error(`VCP audio download for job ${jobId} is not a valid WAV payload (${bytes.length} bytes)`);
      }
      writeAudioBytesAtomically(outWavPath, bytes);
      return { billedUnits: job.tokens_charged };
    }
  }
  throw new Error(`VCP job ${jobId} timed out after ${opts.max_poll_attempts} polls`);
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
  const { voiceId, voiceName, preset } = resolveVoiceFromNarrationSettings(narration, {
    preset: getArg("--voice-preset"),
    voiceId: getArg("--voice"),
    voiceName: getArg("--voice-name"),
  });
  const model = getArg("--model") ?? narration.model;
  const tempoArg = getArg("--tempo");
  let explicitTempo: number | undefined;
  if (tempoArg !== undefined) {
    explicitTempo = Number.parseFloat(tempoArg);
    if (
      !Number.isFinite(explicitTempo) ||
      explicitTempo < VOICE_NARRATION_LIMITS.tempo.min ||
      explicitTempo > VOICE_NARRATION_LIMITS.tempo.max
    ) {
      throw new Error(
        `Invalid --tempo "${tempoArg}": must be in [${VOICE_NARRATION_LIMITS.tempo.min}, ${VOICE_NARRATION_LIMITS.tempo.max}]`,
      );
    }
  }
  const tempo = resolveTempoForVoice(narration, voiceId, explicitTempo);
  const chunkPrefixes = parseChunkPrefixes(getArg("--chunks"));
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
              lexicon: narration.lexicon,
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
      const visibleChunks = chunkPrefixes
        ? plan.chunks.filter((chunk) => chunkPrefixes.some((prefix) => chunk.id.startsWith(prefix)))
        : plan.chunks;
      console.log(`Page ${plan.pdfPageNumber} (label=${plan.bookPageLabel ?? "-"}) -> ${visibleChunks.length} chunks`);
      for (const chunk of visibleChunks) {
        console.log(`  ${chunk.id} | ${JSON.stringify(chunk.text)} -> ${JSON.stringify(chunk.spokenText)}`);
      }
    }
    return;
  }

  const cacheDirArg = getArg("--cache-dir");
  const outDirArg = getArg("--out-dir");
  const audioUrlBase = getArg("--audio-url-base") ?? `${GLOBAL.storefront.audio_base_path}/${book.id}`;
  const cacheDir = cacheDirArg
    ? path.resolve(cacheDirArg)
    : path.join(repoRoot, GLOBAL.paths.cache_dir, "vcp_narration", book.id, voiceId);
  const audioPublicDir = outDirArg
    ? path.resolve(outDirArg)
    : path.join(repoRoot, "web", "public", GLOBAL.storefront.audio_base_path.replace(/^\//, ""), book.id);
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(audioPublicDir, { recursive: true });

  const lock = acquireNarrationLock(cacheDir);
  try {
    const chunkCachePath = (chunk: SpeechChunkPlan) => {
      const hash = createHash("sha256").update(`${voiceId}|${model}|${chunk.spokenText}`).digest("hex").slice(0, 16);
      return {
        wav: path.join(cacheDir, `${hash}.wav`),
        meta: path.join(cacheDir, `${hash}.json`),
      };
    };

    const pendingToSynth = dedupeChunksByCachePath(
      selectPendingChunksToSynth(
        pagePlans,
        selectedPages,
        chunkPrefixes,
        force,
        (chunk) => chunkCachePath(chunk).wav,
        isValidWavFile,
      ),
      (chunk) => chunkCachePath(chunk).wav,
    );

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

    assertSelectedPagesCached(pagePlans, selectedPages, (chunk) => chunkCachePath(chunk).wav, isValidWavFile);

    const pagesManifest: Record<string, PreviewAudioPageTrack> = {};
    for (const plan of pagePlans) {
      if (plan.chunks.length === 0) continue;
      if (!selectedPages.has(plan.pdfPageNumber)) {
        const allCached = plan.chunks.every((chunk) => isValidWavFile(chunkCachePath(chunk).wav));
        if (!allCached) continue;
      }
      const entries = plan.chunks.map((chunk) => {
        const paths = chunkCachePath(chunk);
        const rawPcm = decodeAudioToNativePcm(ffmpegBin, paths.wav, {
          masterFilter: narration.master_filter,
          tempo,
        });
        const trimmedPcm = trimSilencePcm(rawPcm, NATIVE_SAMPLE_RATE, {
          thresholdDb: narration.silence_threshold_db,
          padStartMs: narration.silence_pad_start_ms,
          padEndMs: narration.silence_pad_end_ms,
          fadeMs: narration.silence_fade_ms,
        });
        let chargedUnits: number | undefined;
        if (existsSync(paths.meta)) {
          const meta = JSON.parse(readFileSync(paths.meta, "utf8")) as { tokensCharged?: number | null };
          if (typeof meta.tokensCharged === "number") chargedUnits = meta.tokensCharged;
        }
        return {
          id: chunk.id,
          blockIndex: chunk.blockIndex,
          blockKind: chunk.blockKind,
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
        sectionGapMs: narration.section_gap_ms,
      });

      const fileBase = `page-${String(plan.pdfPageNumber).padStart(2, "0")}`;
      const opusFileName = `${fileBase}.webm`;
      const outOpusPath = path.join(audioPublicDir, opusFileName);
      encodeLoudnormOpus(ffmpegBin, assembled.pcm, outOpusPath, {
        targetLufs: narration.loudnorm_lufs,
        opusCodec: narration.opus_codec,
        opusBitrateKbps: narration.opus_bitrate_kbps,
        opusVbr: narration.opus_vbr,
      });
      const durationMs = probeDurationMs(ffprobeBin, outOpusPath, assembled.rawDurationMs);
      const audioUrl = `${audioUrlBase}/${opusFileName}`;

      pagesManifest[String(plan.pdfPageNumber)] = {
        pageIndex: plan.pageIndex,
        pdfPageNumber: plan.pdfPageNumber,
        ...(plan.bookPageLabel ? { bookPageLabel: plan.bookPageLabel } : {}),
        audioUrl,
        durationMs,
        chunks: assembled.chunks,
      };
      console.log(`[assemble] Wrote ${opusFileName} (${durationMs} ms, ${assembled.chunks.length} chunks)`);
    }

    const manifest: PreviewAudioManifest = {
      version: 1,
      bookId: book.id,
      voiceId,
      voiceName,
      voiceGender: preset,
      model,
      sampleRateHz: OPUS_SAMPLE_RATE_HZ,
      loudnormLufs: narration.loudnorm_lufs,
      generatedAt: new Date().toISOString(),
      pages: pagesManifest,
    };
    const timingsPath = path.join(audioPublicDir, "timings.json");
    writeFileSync(timingsPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`[assemble] Wrote ${timingsPath} (${Object.keys(pagesManifest).length} pages)`);
  } finally {
    lock.release();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error("[narrate_book_preview] Fatal error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
