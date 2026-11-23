import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs";
import { expandHome, GLOBAL } from "../payments/src/settings_registry";
import {
  extractStructuredPageBlocks,
  type AccessibleBlock,
  type PdfTextItemLike,
} from "../web/src/components/storefront/book-previewer-text";
import type { PreviewAudioManifest } from "../web/src/components/storefront/read-aloud-audio";
import {
  evaluateThesisPairProsody,
  extractF0Contour,
  findOpeningThesisPairs,
  medianNumber,
  runLayer1TextLexicon,
  runLayer2ThesisGap,
  runLayer4MasteringTiming,
  type AudioQaReport,
  type OnionLayerResult,
  type PersonaScore,
} from "./audio_qa_layers";

function decodeAudioSegmentPcm(ffmpegBin: string, inputPath: string, startMs: number, endMs: number): Float32Array {
  const args = [
    "-v", "error",
    "-ss", (startMs / 1000).toFixed(3),
    "-to", (endMs / 1000).toFixed(3),
    "-i", inputPath,
    "-f", "s16le",
    "-ac", "1",
    "-ar", "24000",
    "pipe:1",
  ];
  const buf = execFileSync(ffmpegBin, args, { maxBuffer: 16 * 1024 * 1024 });
  const int16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}

/** Layer 3: runs deterministic autocorrelation F0 contour checks on opening thesis pairs. */
export function runLayer3AcousticF0(
  manifest: PreviewAudioManifest,
  webPublicDir: string,
  ffmpegBin: string,
): OnionLayerResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const f0Medians: number[] = [];
  let maxOnsetHz = 0;
  let pairsAnalyzed = 0;

  for (const [pageKey, track] of Object.entries(manifest.pages)) {
    const pairs = findOpeningThesisPairs(track);
    if (pairs.length === 0) continue;
    const diskPath = path.join(webPublicDir, track.audioUrl.replace(/^\//, ""));
    for (const { s0, s1 } of pairs) {
      pairsAnalyzed += 1;
      const pcm0 = decodeAudioSegmentPcm(ffmpegBin, diskPath, s0.startMs, s0.endMs);
      const pcm1 = decodeAudioSegmentPcm(ffmpegBin, diskPath, s1.startMs, Math.min(s1.endMs, s1.startMs + 2000));
      const res = evaluateThesisPairProsody(pageKey, s0.id, s1.id, extractF0Contour(pcm0), extractF0Contour(pcm1));
      failures.push(...res.failures);
      f0Medians.push(res.s0MedianHz);
      if (res.s1OnsetMaxHz > maxOnsetHz) maxOnsetHz = res.s1OnsetMaxHz;
    }
  }

  return {
    layer: "L3_ACOUSTIC_F0",
    passed: failures.length === 0,
    failures,
    warnings,
    metrics: {
      pairsAnalyzed,
      medianBaselineF0Hz: Math.round(medianNumber(f0Medians) * 10) / 10,
      maxOnsetPeakHz: maxOnsetHz,
    },
  };
}

/** Layer 5: computes quantitative listener-experience metrics and 3-persona readiness scorecard. */
export function runLayer5PersonaScorecard(
  manifest: PreviewAudioManifest,
  priorLayers: ReadonlyArray<OnionLayerResult>,
): { layer: OnionLayerResult; personas: PersonaScore[] } {
  let totalWords = 0;
  let totalSpeechMs = 0;
  let totalGapMs = 0;
  let totalDurationMs = 0;

  for (const track of Object.values(manifest.pages)) {
    totalDurationMs += track.durationMs;
    for (let i = 0; i < track.chunks.length; i++) {
      const c = track.chunks[i];
      totalWords += (c.spokenText ?? c.text).trim().split(/\s+/).filter(Boolean).length;
      totalSpeechMs += Math.max(0, c.endMs - c.startMs);
      if (i + 1 < track.chunks.length) {
        totalGapMs += Math.max(0, track.chunks[i + 1].startMs - c.endMs);
      }
    }
  }

  const wpm = totalSpeechMs > 0 ? Math.round((totalWords / (totalSpeechMs / 60000)) * 10) / 10 : 0;
  const pauseRatioPct = totalDurationMs > 0 ? Math.round((totalGapMs / totalDurationMs) * 1000) / 10 : 0;

  const l1 = priorLayers.find((layerItem) => layerItem.layer === "L1_TEXT_LEXICON");
  const l2 = priorLayers.find((layerItem) => layerItem.layer === "L2_THESIS_GAP");
  const l3 = priorLayers.find((layerItem) => layerItem.layer === "L3_ACOUSTIC_F0");
  const l4 = priorLayers.find((layerItem) => layerItem.layer === "L4_MASTERING_TIMING");

  const reqLandmarks = Number(l1?.metrics.requiredLandmarks ?? 0);
  const presLandmarks = Number(l1?.metrics.presentLandmarks ?? 0);
  const landmarkClarityPct = reqLandmarks > 0 ? Math.round((presLandmarks / reqLandmarks) * 100) : 100;

  const wpmInBand = wpm >= 130 && wpm <= 195;
  const failures: string[] = [];
  if (!wpmInBand) failures.push(`Speaking rate ${wpm} WPM outside 130..195 WPM listener band`);

  const personas: PersonaScore[] = [
    {
      persona: "Practitioner / Domain Reader",
      passed: Boolean(l1?.passed && wpmInBand),
      notes: [`Speaking rate: ${wpm} WPM`, `Lexicon & folio hygiene: ${l1?.passed ? "clean" : "failed"}`],
    },
    {
      persona: "Commuting Audio-First Listener",
      passed: Boolean(l2?.passed && l3?.passed && l4?.passed),
      notes: [
        `Pause ratio: ${pauseRatioPct}%`,
        `Max thesis onset F0: ${l3?.metrics.maxOnsetPeakHz ?? 0} Hz`,
        `LUFS target: ${manifest.loudnormLufs}`,
      ],
    },
    {
      persona: "Screen-Reader / Accessibility User",
      passed: Boolean(l1?.passed && l4?.passed && landmarkClarityPct === 100),
      notes: [`Landmark clarity: ${landmarkClarityPct}% (${presLandmarks}/${reqLandmarks})`, `Timing parity: ${l4?.passed ? "100%" : "failed"}`],
    },
  ];

  const layer: OnionLayerResult = {
    layer: "L5_PERSONA_SCORECARD",
    passed: failures.length === 0 && personas.every((persona) => persona.passed),
    failures,
    warnings: [],
    metrics: { wpm, pauseRatioPct, landmarkClarityPct, totalWords },
  };
  return { layer, personas };
}

async function loadPdfPageBlocks(pdfDiskPath: string, totalLimit: number): Promise<Record<string, AccessibleBlock[]>> {
  const data = new Uint8Array(readFileSync(pdfDiskPath));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const out: Record<string, AccessibleBlock[]> = {};
  const count = Math.min(doc.numPages, totalLimit);
  for (let p = 1; p <= count; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    out[String(p)] = extractStructuredPageBlocks(tc.items as PdfTextItemLike[], GLOBAL.book_preview.text_structure, vp.height);
  }
  await doc.destroy();
  return out;
}

export async function runAudioQa(bookArg: string, repoRoot: string): Promise<AudioQaReport> {
  const bookPath = path.isAbsolute(bookArg) ? bookArg : path.join(repoRoot, bookArg);
  const book = JSON.parse(readFileSync(bookPath, "utf8")) as { id: string; preview_pdf?: string | null; preview_audio_manifest?: string | null };
  const webPublicDir = path.join(repoRoot, "web", "public");
  const audioRelDir = path.join(GLOBAL.storefront.audio_base_path.replace(/^\//, ""), book.id);
  const audioDir = path.join(webPublicDir, audioRelDir);
  const timingsPath = book.preview_audio_manifest
    ? path.join(webPublicDir, book.preview_audio_manifest.replace(/^\//, ""))
    : path.join(audioDir, "timings.json");
  const manifest = JSON.parse(readFileSync(timingsPath, "utf8")) as PreviewAudioManifest;

  const home = process.env.HOME ?? "";
  const ffmpegBin = expandHome(GLOBAL.tool_paths.ffmpeg, home);
  const ffprobeBin = expandHome(GLOBAL.tool_paths.ffprobe, home);
  const pageBlocksByNum = book.preview_pdf
    ? await loadPdfPageBlocks(path.join(webPublicDir, book.preview_pdf.replace(/^\//, "")), GLOBAL.book_preview.max_preview_pages)
    : {};
  const totalPages = Object.keys(manifest.pages).length;

  const l1 = runLayer1TextLexicon(manifest, pageBlocksByNum, totalPages, GLOBAL.book_preview.show_cover, GLOBAL.book_preview.text_structure, GLOBAL.voice_narration);
  const l2 = runLayer2ThesisGap(manifest, GLOBAL.voice_narration);
  const l3 = runLayer3AcousticF0(manifest, webPublicDir, ffmpegBin);
  const l4 = runLayer4MasteringTiming(manifest, audioDir, webPublicDir, ffprobeBin);
  const { layer: l5, personas } = runLayer5PersonaScorecard(manifest, [l1, l2, l3, l4]);
  const layers = [l1, l2, l3, l4, l5];

  return {
    bookId: book.id,
    passed: layers.every((l) => l.passed),
    layers,
    personas,
  };
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const bookArg = process.argv.find((arg) => arg.startsWith("--book="))?.slice(7) ?? "books/sample_the_quiet_workshop.json";
  const jsonOut = process.argv.includes("--json");
  const report = await runAudioQa(bookArg, repoRoot);

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== 5-Layer Onion Audio QA Gate (${report.bookId}) ===`);
    for (const layerRes of report.layers) {
      console.log(`[${layerRes.passed ? "PASS" : "FAIL"}] ${layerRes.layer} | ${JSON.stringify(layerRes.metrics)}`);
      for (const failure of layerRes.failures) console.error(`  - ${failure}`);
    }
    for (const personaRes of report.personas) {
      console.log(`[${personaRes.passed ? "PASS" : "FAIL"}] Persona: ${personaRes.persona} (${personaRes.notes.join("; ")})`);
    }
  }
  if (!report.passed) process.exit(1);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error("[audio_qa] Fatal error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
