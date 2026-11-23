import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PreviewAudioManifest, PreviewAudioPageTrack, PreviewAudioTimingChunk } from "../web/src/components/storefront/read-aloud-audio";
import type { AccessibleBlock } from "../web/src/components/storefront/book-previewer-text";
import { classifyPageLandmarkKind, shouldSpeakPageLandmark } from "../web/src/components/storefront/book-preview-landmarks";
import type { BookPreviewTextStructureSettings, VoiceNarrationSettings } from "../payments/src/settings_registry";
import { replaceWholeTermInsensitive } from "./narrate_book_preview_audio";

export type OnionLayerId =
  | "L1_TEXT_LEXICON"
  | "L2_THESIS_GAP"
  | "L3_ACOUSTIC_F0"
  | "L4_MASTERING_TIMING"
  | "L5_PERSONA_SCORECARD";

export interface OnionLayerResult {
  layer: OnionLayerId;
  passed: boolean;
  failures: string[];
  warnings: string[];
  metrics: Record<string, number | string | boolean>;
}

export interface PersonaScore {
  persona: "Practitioner / Domain Reader" | "Commuting Audio-First Listener" | "Screen-Reader / Accessibility User";
  passed: boolean;
  notes: string[];
}

export interface AudioQaReport {
  bookId: string;
  passed: boolean;
  layers: OnionLayerResult[];
  personas: PersonaScore[];
}

const BARE_FOLIO_RE = /^(?:\d{1,4}|[ivxlcdm]{1,7})$/i;
const RAW_ROMAN_YEAR_RE = /\bMMXX[IVX]+\b/;

/** Layer 1: verifies no bare folios, no unexpanded Roman years, lexicon compliance, and spoken landmarks. */
export function runLayer1TextLexicon(
  manifest: PreviewAudioManifest,
  pageBlocksByNum: Record<string, AccessibleBlock[]>,
  totalPages: number,
  showCover: boolean,
  textStructure: BookPreviewTextStructureSettings,
  narration: VoiceNarrationSettings,
): OnionLayerResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  let totalChunks = 0;
  let requiredLandmarks = 0;
  let presentLandmarks = 0;
  const seenChunkIds = new Set<string>();

  for (const [pageKey, track] of Object.entries(manifest.pages)) {
    const blocks = pageBlocksByNum[pageKey] ?? [];
    const kind = classifyPageLandmarkKind(track.pageIndex, totalPages, blocks, showCover);
    const expectSpokenLandmark = shouldSpeakPageLandmark(kind);
    const landmarkLabel = kind ? textStructure.page_landmarks[kind] : null;

    if (expectSpokenLandmark && landmarkLabel && track.chunks.length > 0) {
      const first = track.chunks[0];
      const selfAnnounces = /^(?:chapter|part|contents|table\s+of\s+contents|front\s+cover|title\s+page|back\s+cover)\b/i.test(first.text.trim());
      if (!selfAnnounces) {
        requiredLandmarks += 1;
        const spoken = (first.spokenText ?? "").trim();
        if (spoken.toLowerCase().startsWith(landmarkLabel.toLowerCase())) {
          presentLandmarks += 1;
        } else {
          failures.push(`Page ${pageKey} (${first.id}) missing spoken landmark "${landmarkLabel}." in spokenText="${spoken}"`);
        }
      }
    }

    for (const chunk of track.chunks) {
      totalChunks += 1;
      if (seenChunkIds.has(chunk.id)) {
        failures.push(`Page ${pageKey} duplicate chunk ID "${chunk.id}" across manifest`);
      }
      seenChunkIds.add(chunk.id);
      const text = chunk.text.trim();
      const spoken = (chunk.spokenText ?? chunk.text).trim();
      if (BARE_FOLIO_RE.test(text)) {
        failures.push(`Page ${pageKey} (${chunk.id}) contains bare margin folio "${text}"`);
      }
      if (RAW_ROMAN_YEAR_RE.test(spoken)) {
        failures.push(`Page ${pageKey} (${chunk.id}) contains unexpanded Roman year in spokenText="${spoken}"`);
      }
      for (const entry of narration.lexicon) {
        const flags = entry.flags?.toLowerCase();
        const ci = flags === undefined || flags.includes("i");
        const ra = flags === undefined || flags.includes("g");
        const normalized = replaceWholeTermInsensitive(spoken, entry.pattern, entry.replacement, ci, ra);
        if (normalized !== spoken) {
          failures.push(`Page ${pageKey} (${chunk.id}) contains un-substituted lexicon term "${entry.pattern}" in "${spoken}"`);
        }
      }
    }
  }

  return {
    layer: "L1_TEXT_LEXICON",
    passed: failures.length === 0,
    failures,
    warnings,
    metrics: { totalChunks, requiredLandmarks, presentLandmarks },
  };
}

/** Identifies opening thesis pairs (short s0 <= 45 chars followed by s1 in blockIndex 0). */
export function findOpeningThesisPairs(track: PreviewAudioPageTrack): Array<{ s0: PreviewAudioTimingChunk; s1: PreviewAudioTimingChunk }> {
  const pairs: Array<{ s0: PreviewAudioTimingChunk; s1: PreviewAudioTimingChunk }> = [];
  if (track.chunks.length < 2) return pairs;
  const s0 = track.chunks[0];
  const s1 = track.chunks[1];
  if (s0.blockIndex === 0 && s1.blockIndex === 0 && s0.text.trim().length <= 45 && !s0.id.includes("cover")) {
    pairs.push({ s0, s1 });
  }
  return pairs;
}

/** Layer 2: verifies opening thesis sentences have >= opening_statement_gap_ms - 20ms pause before s1. */
export function runLayer2ThesisGap(
  manifest: PreviewAudioManifest,
  narration: VoiceNarrationSettings,
): OnionLayerResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const minGapMs = Math.max(0, narration.opening_statement_gap_ms - 20);
  let pairsChecked = 0;

  for (const [pageKey, track] of Object.entries(manifest.pages)) {
    for (const { s0, s1 } of findOpeningThesisPairs(track)) {
      pairsChecked += 1;
      const gapMs = s1.startMs - s0.endMs;
      if (gapMs < minGapMs) {
        failures.push(`Page ${pageKey} (${s0.id}->${s1.id}) thesis pause ${gapMs}ms < required ${minGapMs}ms`);
      }
    }
  }

  return {
    layer: "L2_THESIS_GAP",
    passed: failures.length === 0,
    failures,
    warnings,
    metrics: { pairsChecked, minRequiredGapMs: minGapMs },
  };
}

/** Deterministic autocorrelation F0 contour extraction on 24 kHz mono PCM (60-260 Hz). */
export function extractF0Contour(samples: Float32Array, sampleRate = 24000): Array<{ timeSec: number; f0Hz: number }> {
  const win = Math.round(0.04 * sampleRate);
  const hop = Math.round(0.01 * sampleRate);
  const minLag = Math.round(sampleRate / 260);
  const maxLag = Math.round(sampleRate / 60);
  const out: Array<{ timeSec: number; f0Hz: number }> = [];

  for (let start = 0; start + win <= samples.length; start += hop) {
    let sumSq = 0;
    let sum = 0;
    for (let idx = 0; idx < win; idx++) {
      const sample = samples[start + idx];
      sum += sample;
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / win);
    if (rms < 0.02) continue;
    const mean = sum / win;
    const corrs = new Float32Array(maxLag + 1);
    let bestLag = -1;
    let bestCorr = -1;
    for (let lag = minLag; lag < maxLag; lag++) {
      let acc = 0;
      let energyA = 0;
      let energyB = 0;
      const limit = win - lag;
      for (let idx = 0; idx < limit; idx++) {
        const sampleA = samples[start + idx] - mean;
        const sampleB = samples[start + idx + lag] - mean;
        acc += sampleA * sampleB;
        energyA += sampleA * sampleA;
        energyB += sampleB * sampleB;
      }
      const denom = Math.sqrt(energyA * energyB);
      const corrVal = denom > 0 ? acc / denom : 0;
      corrs[lag] = corrVal;
      if (corrVal > bestCorr) {
        bestCorr = corrVal;
        bestLag = lag;
      }
    }
    if (bestCorr > 0.45 && bestLag > 0) {
      // Pick the smallest lag achieving >= 98% of global peak so pure tones keep true F0 while sub-harmonics lose to true fundamental.
      for (let lag = minLag; lag < bestLag; lag++) {
        if (corrs[lag] >= 0.98 * bestCorr && corrs[lag] >= corrs[lag - 1] && corrs[lag] >= corrs[lag + 1]) {
          bestLag = lag;
          break;
        }
      }
      out.push({ timeSec: start / sampleRate, f0Hz: sampleRate / bestLag });
    }
  }
  return out;
}

export function medianNumber(nums: ReadonlyArray<number>): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Computes 7-frame (70ms) median-smoothed F0 values to reject <=30ms consonant-transition artifacts. */
export function smoothedF0Values(frames: ReadonlyArray<{ f0Hz: number }>): number[] {
  if (frames.length < 3) return frames.map((f) => f.f0Hz);
  const out: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const lo = Math.max(0, i - 3);
    const hi = Math.min(frames.length - 1, i + 3);
    out.push(medianNumber(frames.slice(lo, hi + 1).map((f) => f.f0Hz)));
  }
  return out;
}

/** Evaluates L3 acoustic prosody rules on a decoded thesis pair (terminal fall on s0 + onset ceiling on s1). */
export function evaluateThesisPairProsody(
  pageKey: string,
  s0Id: string,
  s1Id: string,
  s0Frames: ReadonlyArray<{ timeSec: number; f0Hz: number }>,
  s1Frames: ReadonlyArray<{ timeSec: number; f0Hz: number }>,
): { failures: string[]; s0MedianHz: number; s0TailMinHz: number; s1OnsetMaxHz: number } {
  const failures: string[] = [];
  const s0Vals = s0Frames.map((f) => f.f0Hz);
  const s0MedianHz = medianNumber(s0Vals);
  const tailSlice = s0Vals.slice(-Math.min(5, s0Vals.length));
  const s0TailMinHz = tailSlice.length > 0 ? Math.min(...tailSlice) : 0;

  if (s0Vals.length < 6) {
    failures.push(`Page ${pageKey} (${s0Id}) insufficient voiced F0 frames (${s0Vals.length} < 6) to validate terminal inflection`);
  } else if (s0TailMinHz >= s0MedianHz * 0.96 && s0TailMinHz > 85) {
    failures.push(`Page ${pageKey} (${s0Id}) non-final terminal inflection: tailMin=${s0TailMinHz.toFixed(1)}Hz >= median=${s0MedianHz.toFixed(1)}Hz`);
  }

  const onsetFrames = s1Frames.filter((f) => f.timeSec <= 1.5);
  const smoothedOnset = smoothedF0Values(onsetFrames);
  const s1OnsetMaxHz = smoothedOnset.length > 0 ? Math.max(...smoothedOnset) : 0;
  if (onsetFrames.length === 0) {
    failures.push(`Page ${pageKey} (${s1Id}) insufficient voiced F0 frames (0) in 0..1.5s onset window`);
  } else if (s1OnsetMaxHz > 175) {
    failures.push(`Page ${pageKey} (${s1Id}) onset F0 spike ${s1OnsetMaxHz.toFixed(1)}Hz > 175Hz ceiling`);
  }

  return {
    failures,
    s0MedianHz: Math.round(s0MedianHz * 10) / 10,
    s0TailMinHz: Math.round(s0TailMinHz * 10) / 10,
    s1OnsetMaxHz: Math.round(s1OnsetMaxHz * 10) / 10,
  };
}

/** Layer 4: verifies .webm existence, 48 kHz Opus stream, durationMs parity (±150ms), monotonic chunks, and 0 .mp3 files. */
export function runLayer4MasteringTiming(
  manifest: PreviewAudioManifest,
  audioDir: string,
  webPublicDir: string,
  ffprobeBin: string,
): OnionLayerResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  let tracksChecked = 0;

  if (manifest.version !== 1 || manifest.sampleRateHz !== 48000) {
    failures.push(`Manifest header invalid: version=${manifest.version}, sampleRateHz=${manifest.sampleRateHz}`);
  }
  if (existsSync(audioDir)) {
    const mp3Files = readdirSync(audioDir).filter((f) => f.toLowerCase().endsWith(".mp3"));
    if (mp3Files.length > 0) {
      failures.push(`Stale MP3 files present in ${audioDir}: ${mp3Files.join(", ")}`);
    }
  }

  for (const [pageKey, track] of Object.entries(manifest.pages)) {
    tracksChecked += 1;
    const rel = track.audioUrl.replace(/^\//, "");
    const diskPath = path.join(webPublicDir, rel);
    if (!existsSync(diskPath)) {
      failures.push(`Page ${pageKey} audio file missing on disk: ${diskPath}`);
      continue;
    }
    try {
      const raw = execFileSync(
        ffprobeBin,
        ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", diskPath],
        { encoding: "utf8" },
      );
      const parsed = JSON.parse(raw) as {
        format?: { duration?: string };
        streams?: Array<{ codec_name?: string; sample_rate?: string }>;
      };
      const opusStream = parsed.streams?.find((s) => s.codec_name === "opus");
      if (!opusStream) {
        failures.push(`Page ${pageKey} (${track.audioUrl}) missing opus audio stream`);
      } else if (opusStream.sample_rate && opusStream.sample_rate !== "48000") {
        failures.push(`Page ${pageKey} (${track.audioUrl}) sample_rate=${opusStream.sample_rate}, expected 48000`);
      }
      const actualMs = Math.round(Number.parseFloat(parsed.format?.duration ?? "0") * 1000);
      if (!Number.isFinite(actualMs) || Math.abs(actualMs - track.durationMs) > 150) {
        failures.push(`Page ${pageKey} duration mismatch: manifest=${track.durationMs}ms vs ffprobe=${actualMs}ms`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[audio_qa] Page ${pageKey} ffprobe error:`, msg);
      failures.push(`Page ${pageKey} ffprobe error: ${msg}`);
    }

    let prevEnd = 0;
    for (const chunk of track.chunks) {
      if (chunk.startMs < 0 || chunk.endMs <= chunk.startMs) {
        failures.push(`Page ${pageKey} (${chunk.id}) invalid timing bounds ${chunk.startMs}..${chunk.endMs}`);
      }
      if (chunk.startMs < prevEnd) {
        failures.push(`Page ${pageKey} (${chunk.id}) overlaps previous chunk (${chunk.startMs} < ${prevEnd})`);
      }
      if (chunk.endMs > track.durationMs + 50) {
        failures.push(`Page ${pageKey} (${chunk.id}) endMs=${chunk.endMs} exceeds durationMs=${track.durationMs}`);
      }
      prevEnd = chunk.endMs;
    }
  }

  return {
    layer: "L4_MASTERING_TIMING",
    passed: failures.length === 0,
    failures,
    warnings,
    metrics: { tracksChecked, sampleRateHz: manifest.sampleRateHz },
  };
}
