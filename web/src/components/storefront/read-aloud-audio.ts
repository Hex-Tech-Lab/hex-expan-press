import type { ReadAloudChunk } from "./book-previewer-text";

export interface PreviewAudioTimingChunk {
  id: string;
  blockIndex: number;
  text: string;
  spokenText?: string;
  startMs: number;
  endMs: number;
  tokensCharged?: number;
}

export interface PreviewAudioPageTrack {
  pageIndex: number;
  pdfPageNumber: number;
  bookPageLabel?: string;
  audioUrl: string;
  durationMs: number;
  chunks: PreviewAudioTimingChunk[];
}

export interface PreviewAudioManifest {
  version: 1;
  bookId: string;
  voiceId: string;
  voiceName: string;
  model: string;
  sampleRateHz: number;
  loudnormLufs: number;
  generatedAt: string;
  pages: Record<string, PreviewAudioPageTrack>;
}

export function detectAudioSupport(): boolean {
  return typeof window !== "undefined" && typeof window.Audio === "function";
}

export function isSafeAudioTrackUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  const trimmed = value.trim();
  if (trimmed.includes("..") || trimmed.includes("\\")) return false;
  if (/^\/books\/audio\/[a-z0-9/_-]+\.(?:mp3|wav|ogg|m4a)$/i.test(trimmed)) return true;
  if (trimmed.startsWith("https://") && URL.canParse(trimmed)) {
    const parsedUrl = new URL(trimmed);
    return parsedUrl.protocol === "https:" && !parsedUrl.username && !parsedUrl.password;
  }
  return false;
}

export function parsePreviewAudioManifest(raw: unknown): PreviewAudioManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.version !== 1 || !rec.pages || typeof rec.pages !== "object" || Array.isArray(rec.pages)) {
    return null;
  }
  const pages: Record<string, PreviewAudioPageTrack> = {};
  for (const [pageKey, entry] of Object.entries(rec.pages as Record<string, unknown>)) {
    if (!/^\d+$/.test(pageKey) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const trackRec = entry as Record<string, unknown>;
    if (
      typeof trackRec.pageIndex !== "number" ||
      !Number.isInteger(trackRec.pageIndex) ||
      typeof trackRec.pdfPageNumber !== "number" ||
      !Number.isInteger(trackRec.pdfPageNumber) ||
      !isSafeAudioTrackUrl(trackRec.audioUrl) ||
      typeof trackRec.durationMs !== "number" ||
      !Number.isFinite(trackRec.durationMs) ||
      !Array.isArray(trackRec.chunks)
    ) {
      continue;
    }
    const validChunks: PreviewAudioTimingChunk[] = [];
    let chunksOk = true;
    for (const chunkRaw of trackRec.chunks) {
      if (!chunkRaw || typeof chunkRaw !== "object" || Array.isArray(chunkRaw)) {
        chunksOk = false;
        break;
      }
      const chunkRec = chunkRaw as Record<string, unknown>;
      if (
        typeof chunkRec.id !== "string" ||
        chunkRec.id === "" ||
        typeof chunkRec.blockIndex !== "number" ||
        typeof chunkRec.text !== "string" ||
        typeof chunkRec.startMs !== "number" ||
        !Number.isFinite(chunkRec.startMs) ||
        typeof chunkRec.endMs !== "number" ||
        !Number.isFinite(chunkRec.endMs)
      ) {
        chunksOk = false;
        break;
      }
      validChunks.push({
        id: chunkRec.id,
        blockIndex: chunkRec.blockIndex,
        text: chunkRec.text,
        ...(typeof chunkRec.spokenText === "string" ? { spokenText: chunkRec.spokenText } : {}),
        startMs: chunkRec.startMs,
        endMs: chunkRec.endMs,
        ...(typeof chunkRec.tokensCharged === "number" ? { tokensCharged: chunkRec.tokensCharged } : {}),
      });
    }
    if (!chunksOk || validChunks.length === 0) continue;
    validChunks.sort((a, b) => a.startMs - b.startMs);
    pages[pageKey] = {
      pageIndex: trackRec.pageIndex,
      pdfPageNumber: trackRec.pdfPageNumber,
      ...(typeof trackRec.bookPageLabel === "string" ? { bookPageLabel: trackRec.bookPageLabel } : {}),
      audioUrl: trackRec.audioUrl.trim(),
      durationMs: trackRec.durationMs,
      chunks: validChunks,
    };
  }
  if (Object.keys(pages).length === 0) return null;
  return {
    version: 1,
    bookId: typeof rec.bookId === "string" ? rec.bookId : "",
    voiceId: typeof rec.voiceId === "string" ? rec.voiceId : "",
    voiceName: typeof rec.voiceName === "string" ? rec.voiceName : "",
    model: typeof rec.model === "string" ? rec.model : "",
    sampleRateHz: typeof rec.sampleRateHz === "number" ? rec.sampleRateHz : 44100,
    loudnormLufs: typeof rec.loudnormLufs === "number" ? rec.loudnormLufs : -16,
    generatedAt: typeof rec.generatedAt === "string" ? rec.generatedAt : "",
    pages,
  };
}

export function applyAudioPlaybackRate(audio: HTMLAudioElement, rate: number): void {
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
  audio.preservesPitch = true;
  const ext = audio as HTMLAudioElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };
  if ("webkitPreservesPitch" in ext) ext.webkitPreservesPitch = true;
  if ("mozPreservesPitch" in ext) ext.mozPreservesPitch = true;
}

export function chunkIndexForTrackTime(
  track: PreviewAudioPageTrack,
  timeSec: number,
  allChunks: ReadonlyArray<ReadAloudChunk>,
): number | null {
  if (track.chunks.length === 0) return null;
  const posMs = Math.max(0, timeSec * 1000);
  let matched = track.chunks[0];
  for (let i = 1; i < track.chunks.length; i++) {
    if (track.chunks[i].startMs <= posMs) {
      matched = track.chunks[i];
    } else {
      break;
    }
  }
  const idx = allChunks.findIndex((chunk) => chunk.id === matched.id);
  return idx >= 0 ? idx : null;
}

export function resolveSpreadAudioTracks(
  manifest: PreviewAudioManifest | null,
  chunks: ReadonlyArray<ReadAloudChunk>,
): PreviewAudioPageTrack[] | null {
  if (!manifest || chunks.length === 0) return null;
  const pageOrder: number[] = [];
  const byPage = new Map<number, ReadAloudChunk[]>();
  for (const chunk of chunks) {
    let list = byPage.get(chunk.pageIndex);
    if (!list) {
      list = [];
      byPage.set(chunk.pageIndex, list);
      pageOrder.push(chunk.pageIndex);
    }
    list.push(chunk);
  }
  const tracks: PreviewAudioPageTrack[] = [];
  for (const pageIndex of pageOrder) {
    const track = manifest.pages[String(pageIndex + 1)];
    if (!track || track.chunks.length === 0) return null;
    const trackIds = new Set(track.chunks.map((tc) => tc.id));
    const pageChunks = byPage.get(pageIndex) ?? [];
    if (!pageChunks.every((chunk) => trackIds.has(chunk.id))) return null;
    tracks.push(track);
  }
  return tracks.length > 0 ? tracks : null;
}

export function playAudioWithErrorHandler(
  audio: HTMLAudioElement,
  onFailure: (reason: unknown) => void,
): void {
  try {
    const playResult = audio.play();
    if (playResult && typeof playResult.catch === "function") {
      playResult.catch((err: unknown) => {
        if ((err as { name?: string } | null)?.name === "AbortError") return;
        console.warn("[read-aloud] Audio play rejected:", err);
        onFailure(err);
      });
    }
  } catch (err) {
    console.warn("[read-aloud] Audio play threw synchronously:", err);
    onFailure(err);
  }
}
