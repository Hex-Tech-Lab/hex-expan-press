import { execFileSync, spawnSync } from "node:child_process";
import {
  DEFAULT_GLOBAL,
  type VoiceNarrationLexiconEntry,
  type VoiceNarrationSettings,
} from "../payments/src/settings_registry";
import type { AccessibleBlock, PreviewAudioTimingChunk } from "../web/src/components/storefront/book-previewer-text";

export const NATIVE_SAMPLE_RATE = 24000;
export const OPUS_SAMPLE_RATE_HZ = 48000;

const ROMAN_YEAR_MAP: Record<string, string> = {
  MMXXIV: "2024",
  MMXXV: "2025",
  MMXXVI: "2026",
  MMXXVII: "2027",
};
const METADATA_CUES_RE =
  /^(?:D\s+E\s+T\s*A\s+I\s+L\s+S|A\s+B\s+O\s+U\s+T\s+T\s+H\s+E\s+A\s+U\s+T\s+H\s+O\s+R|Sample:\s*Chapter\b|Trim\b.*\bLanguage\b)|\|\s*MMXX[IVX]+\b/i;

export function parsePageSelection(raw: string | undefined, maxPage: number): Set<number> {
  if (raw === undefined) {
    return new Set(Array.from({ length: maxPage }, (_, i) => i + 1));
  }
  if (!raw.trim()) {
    throw new Error(`Invalid --pages selector "${raw}": matched 0 valid pages in 1..${maxPage}`);
  }
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
    if (rangeMatch) {
      const startPage = Number.parseInt(rangeMatch[1], 10);
      const endPage = Number.parseInt(rangeMatch[2], 10);
      if (startPage < 1 || endPage < 1 || startPage > maxPage || endPage > maxPage) {
        throw new Error(`Invalid --pages range "${trimmed}": must stay within 1..${maxPage}`);
      }
      for (let page = Math.min(startPage, endPage); page <= Math.max(startPage, endPage); page++) {
        out.add(page);
      }
      continue;
    }
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`Invalid --pages entry "${trimmed}": expected page number or range within 1..${maxPage}`);
    }
    const single = Number.parseInt(trimmed, 10);
    if (single < 1 || single > maxPage) {
      throw new Error(`Invalid --pages value ${single}: must stay within 1..${maxPage}`);
    }
    out.add(single);
  }
  if (out.size === 0) {
    throw new Error(`Invalid --pages selector "${raw}": matched 0 valid pages in 1..${maxPage}`);
  }
  return out;
}

export function resolveVoiceFromNarrationSettings(
  narration: VoiceNarrationSettings,
  opts: { preset?: string; voiceId?: string; voiceName?: string } = {},
): { voiceId: string; voiceName: string; preset: "male" | "female" } {
  const rawPreset = opts.preset?.trim().toLowerCase();
  if (rawPreset && rawPreset !== "male" && rawPreset !== "female") {
    throw new Error(`Unsupported --voice-preset "${opts.preset}"; expected "male" or "female"`);
  }
  const preset: "male" | "female" = rawPreset === "female" ? "female" : "male";
  const defaultId = preset === "female" ? narration.fallback_female_voice_id : narration.default_voice_id;
  const defaultName = preset === "female" ? narration.fallback_female_voice_name : narration.default_voice_name;
  return {
    preset,
    voiceId: opts.voiceId?.trim() || defaultId,
    voiceName: opts.voiceName?.trim() || defaultName,
  };
}

/** Derives whether an extracted PDF page is discrete cover/TOC/back-cover metadata rather than flowing prose. */
export function isMetadataBookPage(blocks: ReadonlyArray<AccessibleBlock>): boolean {
  if (blocks.length === 0) return false;
  if (blocks.every((block) => block.kind !== "paragraph")) return true;
  const paragraphBlocks = blocks.filter((block) => block.kind === "paragraph");
  const maxParagraphLen = paragraphBlocks.reduce((max, block) => Math.max(max, block.text.trim().length), 0);
  const hasMetadataCue = blocks.some((block) => METADATA_CUES_RE.test(block.text.trim()));
  if (hasMetadataCue && maxParagraphLen <= 180) return true;
  return blocks.length <= 6 && blocks.every((block) => block.text.trim().length <= 120);
}

function toTitleCaseWords(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function isTermWordChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/** Replaces whole-word/phrase occurrences without dynamic RegExp construction. */
export function replaceWholeTermInsensitive(
  text: string,
  from: string,
  replacement: string,
  caseInsensitive = true,
  replaceAll = true,
): string {
  if (!from || text.length < from.length) return text;
  const haystack = caseInsensitive ? text.toLowerCase() : text;
  const needle = caseInsensitive ? from.toLowerCase() : from;
  const needLeftBoundary = isTermWordChar(from[0]);
  const needRightBoundary = isTermWordChar(from[from.length - 1]);

  const parts: string[] = [];
  let lastCopy = 0;
  let cursor = 0;
  while (cursor <= text.length - needle.length) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx < 0) break;
    const rightEnd = idx + needle.length;
    const leftOk = !needLeftBoundary || idx === 0 || !isTermWordChar(text[idx - 1]);
    const rightOk = !needRightBoundary || rightEnd === text.length || !isTermWordChar(text[rightEnd]);
    if (leftOk && rightOk) {
      parts.push(text.slice(lastCopy, idx), replacement);
      lastCopy = rightEnd;
      cursor = rightEnd;
      if (!replaceAll) break;
    } else {
      cursor = idx + 1;
    }
  }
  if (lastCopy === 0) return text;
  parts.push(text.slice(lastCopy));
  return parts.join("");
}

/** Applies configurable TTS pronunciation substitutions cleanly to spoken text only. */
export function applyNarrationLexicon(
  text: string,
  lexicon: ReadonlyArray<VoiceNarrationLexiconEntry>,
): string {
  let out = text;
  for (const entry of lexicon) {
    const flags = entry.flags?.toLowerCase();
    const caseInsensitive = flags === undefined || flags.includes("i");
    const replaceAll = flags === undefined || flags.includes("g");
    out = replaceWholeTermInsensitive(out, entry.pattern, entry.replacement, caseInsensitive, replaceAll);
  }
  return out;
}

/** Normalizes sparse cover/metadata typography into natural calm documentary phrasing without altering UI chunk text. */
export function formatChunkForSpeech(
  text: string,
  blockKind: AccessibleBlock["kind"],
  options: { isMetadataPage?: boolean; authorName?: string; lexicon?: ReadonlyArray<VoiceNarrationLexiconEntry> } = {},
): string {
  let normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  if (/^D\s+E\s+T\s*A\s+I\s+L\s+S$/i.test(normalized)) {
    return "Details.";
  }
  if (/^A\s+B\s+O\s+U\s+T\s+T\s+H\s+E\s+A\s+U\s+T\s+H\s+O\s+R$/i.test(normalized)) {
    return "About the author.";
  }
  if (/^[A-Z](?:\s+[A-Z]){3,}$/.test(normalized)) {
    normalized = toTitleCaseWords(normalized.replace(/\s+/g, ""));
  }

  normalized = normalized.replace(/\s*\|\s*/g, ", ");
  normalized = normalized.replace(/\b(MMXX[IVX]+)\b/g, (match) => ROMAN_YEAR_MAP[match.toUpperCase()] ?? match);

  if (/^Trim\b/i.test(normalized) && /\bLanguage\b/i.test(normalized)) {
    normalized = normalized
      .replace(/^Trim\s+/i, "Trim: ")
      .replace(/\s*×\s*/g, " by ")
      .replace(/\bin\s+Language\s+/i, "inches. Language: ");
  } else {
    normalized = normalized.replace(/(\d)\s*×\s*(\d)/g, "$1 by $2");
  }

  if (options.isMetadataPage) {
    if (normalized === normalized.toUpperCase() && /[A-Z]{2,}/.test(normalized)) {
      if (normalized === "EXPANPRESS") {
        normalized = "ExpanPress";
      } else if (options.authorName && normalized === options.authorName.toUpperCase()) {
        normalized = `By ${options.authorName}`;
      } else {
        normalized = toTitleCaseWords(normalized);
      }
    } else if (options.authorName && normalized === options.authorName) {
      normalized = `By ${options.authorName}`;
    }
  }

  // Strip stray unmatched curly quote at chunk boundary so TTS pauses cleanly.
  if (normalized.startsWith("“") && !normalized.includes("”")) normalized = normalized.slice(1).trim();
  if (normalized.endsWith("”") && !normalized.includes("“")) normalized = normalized.slice(0, -1).trim();

  const activeLexicon = options.lexicon ?? DEFAULT_GLOBAL.voice_narration.lexicon;
  if (activeLexicon.length > 0) {
    normalized = applyNarrationLexicon(normalized, activeLexicon);
  }

  const isMetadataOrDiscrete =
    blockKind === "heading" || blockKind === "list-item" || Boolean(options.isMetadataPage);
  if (isMetadataOrDiscrete && !/[.!?…]$/.test(normalized)) {
    normalized = `${normalized}.`;
  }
  return normalized;
}

/** Trims dead leading/trailing silence from 16-bit mono PCM while preserving soft onsets and smooth fades. */
export function trimSilencePcm(
  samples: Int16Array,
  sampleRate: number,
  opts: { thresholdDb: number; padStartMs: number; padEndMs: number; fadeMs?: number },
): Int16Array {
  if (samples.length === 0) return samples;
  const threshold = Math.max(1, Math.round(32768 * Math.pow(10, opts.thresholdDb / 20)));
  let firstActive = -1;
  let lastActive = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > threshold) {
      if (firstActive < 0) firstActive = i;
      lastActive = i;
    }
  }
  if (firstActive < 0 || lastActive < 0) {
    return samples;
  }
  const padStartSamples = Math.round((opts.padStartMs / 1000) * sampleRate);
  const padEndSamples = Math.round((opts.padEndMs / 1000) * sampleRate);
  const start = Math.max(0, firstActive - padStartSamples);
  const end = Math.min(samples.length, lastActive + padEndSamples);
  const out = new Int16Array(samples.slice(start, end));

  const fadeSamples = Math.min(Math.round(((opts.fadeMs ?? 18) / 1000) * sampleRate), Math.floor(out.length / 4));
  for (let i = 0; i < fadeSamples; i++) {
    const gainIn = i / fadeSamples;
    const gainOut = (fadeSamples - 1 - i) / fadeSamples;
    out[i] = Math.round(out[i] * gainIn);
    out[out.length - fadeSamples + i] = Math.round(out[out.length - fadeSamples + i] * gainOut);
  }
  return out;
}

/** Concatenates trimmed chunk PCMs with breath/section gaps and records exact sample-derived chunk timings. */
export function assemblePagePcm(
  entries: ReadonlyArray<{
    id: string;
    blockIndex: number;
    blockKind?: AccessibleBlock["kind"];
    text: string;
    spokenText: string;
    tokensCharged?: number;
    pcm: Int16Array;
  }>,
  opts: {
    sampleRate: number;
    pageLeadMs: number;
    pageTailMs: number;
    sentenceGapMs: number;
    paragraphGapMs: number;
    sectionGapMs?: number;
  },
): { pcm: Int16Array; chunks: PreviewAudioTimingChunk[]; rawDurationMs: number } {
  const leadSamples = Math.round((opts.pageLeadMs / 1000) * opts.sampleRate);
  const tailSamples = Math.round((opts.pageTailMs / 1000) * opts.sampleRate);
  const sentenceGapSamples = Math.round((opts.sentenceGapMs / 1000) * opts.sampleRate);
  const paragraphGapSamples = Math.round((opts.paragraphGapMs / 1000) * opts.sampleRate);
  const sectionGapSamples = Math.round(((opts.sectionGapMs ?? opts.paragraphGapMs) / 1000) * opts.sampleRate);

  const segments: Array<{ startSample: number; pcm: Int16Array }> = [];
  const chunks: PreviewAudioTimingChunk[] = [];
  let cursor = leadSamples;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const startSample = cursor;
    const endSample = startSample + entry.pcm.length;
    segments.push({ startSample, pcm: entry.pcm });
    chunks.push({
      id: entry.id,
      blockIndex: entry.blockIndex,
      text: entry.text,
      spokenText: entry.spokenText,
      startMs: Math.round((startSample * 1000) / opts.sampleRate),
      endMs: Math.round((endSample * 1000) / opts.sampleRate),
      ...(typeof entry.tokensCharged === "number" ? { tokensCharged: entry.tokensCharged } : {}),
    });
    cursor = endSample;
    if (i + 1 < entries.length) {
      const next = entries[i + 1];
      if (next.blockIndex === entry.blockIndex) {
        cursor += sentenceGapSamples;
      } else if (entry.blockKind === "heading" || next.blockKind === "heading") {
        cursor += sectionGapSamples;
      } else {
        cursor += paragraphGapSamples;
      }
    }
  }

  const totalSamples = cursor + tailSamples;
  const pcm = new Int16Array(totalSamples);
  for (const seg of segments) {
    pcm.set(seg.pcm, seg.startSample);
  }
  return {
    pcm,
    chunks,
    rawDurationMs: Math.round((totalSamples * 1000) / opts.sampleRate),
  };
}

export function buildChunkDecodeFilter(opts?: { masterFilter?: string; tempo?: number }): string | null {
  const parts: string[] = [];
  const filter = opts?.masterFilter?.trim();
  if (filter) parts.push(filter);
  const tempo = opts?.tempo;
  if (typeof tempo === "number" && Number.isFinite(tempo) && Math.abs(tempo - 1) > 1e-4) {
    parts.push(`atempo=${tempo}`);
  }
  return parts.length > 0 ? parts.join(",") : null;
}

export function parseChunkPrefixes(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const items = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(`Invalid --chunks selector "${raw}": expected comma-separated chunk id prefixes`);
  }
  return items;
}

export function decodeAudioToNativePcm(
  ffmpegBin: string,
  inputPath: string,
  opts?: { masterFilter?: string; tempo?: number },
): Int16Array {
  const filter = buildChunkDecodeFilter(opts);
  const args = ["-v", "error", "-i", inputPath];
  if (filter) args.push("-af", filter);
  args.push("-f", "s16le", "-ac", "1", "-ar", String(NATIVE_SAMPLE_RATE), "pipe:1");
  const buf = execFileSync(ffmpegBin, args, { maxBuffer: 64 * 1024 * 1024 });
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

export function encodeLoudnormDualFormats(
  ffmpegBin: string,
  pcm: Int16Array,
  outMp3Path: string,
  outOpusPath: string,
  opts: {
    targetLufs: number;
    sampleRateHz: number;
    mp3BitrateKbps: number;
    opusCodec: string;
    opusBitrateKbps: number;
    opusVbr: "on" | "off" | "constrained";
  },
): void {
  const tmpWav = `${outMp3Path}.tmp.wav`;
  const pcmBuf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  execFileSync(
    ffmpegBin,
    ["-y", "-v", "error", "-f", "s16le", "-ar", String(NATIVE_SAMPLE_RATE), "-ac", "1", "-i", "pipe:0", tmpWav],
    { input: pcmBuf },
  );

  let measuredFilter = `loudnorm=I=${opts.targetLufs}:TP=-1.5:LRA=11`;
  try {
    const pass1 = spawnSync(
      ffmpegBin,
      ["-nostdin", "-y", "-i", tmpWav, "-af", `${measuredFilter}:print_format=json`, "-f", "null", "-"],
      { encoding: "utf8" },
    );
    const pass1Log = `${pass1.stdout ?? ""}\n${pass1.stderr ?? ""}`;
    const jsonMatch = /\{[\s\S]*"input_i"[\s\S]*\}/.exec(pass1Log);
    if (pass1.status === 0 && jsonMatch) {
      const stats = JSON.parse(jsonMatch[0]) as Record<string, string>;
      if (stats.input_i && stats.input_tp && stats.input_lra && stats.input_thresh && stats.target_offset) {
        measuredFilter = `loudnorm=I=${opts.targetLufs}:TP=-1.5:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`;
      }
    }
  } catch (err) {
    console.warn("[narrate_book_preview] loudnorm pass1 measurement failed; using single-pass fallback:", err);
  }

  execFileSync(
    ffmpegBin,
    [
      "-y",
      "-v",
      "error",
      "-i",
      tmpWav,
      "-af",
      measuredFilter,
      "-ar",
      String(opts.sampleRateHz),
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      `${opts.mp3BitrateKbps}k`,
      outMp3Path,
    ],
  );
  execFileSync(
    ffmpegBin,
    [
      "-y",
      "-v",
      "error",
      "-i",
      tmpWav,
      "-af",
      measuredFilter,
      "-ar",
      String(OPUS_SAMPLE_RATE_HZ),
      "-ac",
      "1",
      "-c:a",
      opts.opusCodec,
      "-b:a",
      `${opts.opusBitrateKbps}k`,
      "-vbr",
      opts.opusVbr,
      outOpusPath,
    ],
  );
  execFileSync("rm", ["-f", tmpWav]);
}

export function probeDurationMs(ffprobeBin: string, mp3Path: string, fallbackMs: number): number {
  try {
    const raw = execFileSync(
      ffprobeBin,
      ["-v", "quiet", "-print_format", "json", "-show_format", mp3Path],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(raw) as { format?: { duration?: string } };
    const sec = Number.parseFloat(parsed.format?.duration ?? "");
    if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  } catch (err) {
    console.warn(`[narrate_book_preview] ffprobe fallback to raw duration for ${mp3Path}:`, err);
  }
  return fallbackMs;
}
