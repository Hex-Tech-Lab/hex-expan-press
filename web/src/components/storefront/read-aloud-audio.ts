import type { ReadAloudChunk } from "./book-previewer-text";

export interface PreviewAudioTimingWord {
  start: number;
  end: number;
  startMs: number;
  endMs: number;
}

export interface PreviewAudioTimingChunk {
  id: string;
  blockIndex: number;
  text: string;
  spokenText?: string;
  startMs: number;
  endMs: number;
  tokensCharged?: number;
  words?: PreviewAudioTimingWord[];
}

export interface PreviewAudioPageTrack {
  pageIndex: number;
  pdfPageNumber: number;
  bookPageLabel?: string;
  audioUrl: string;
  opusUrl?: string;
  durationMs: number;
  chunks: PreviewAudioTimingChunk[];
}

export interface PreviewAudioManifest {
  version: 1;
  bookId: string;
  voiceId: string;
  voiceName: string;
  voiceGender?: "male" | "female";
  model: string;
  sampleRateHz: number;
  loudnormLufs: number;
  generatedAt: string;
  pages: Record<string, PreviewAudioPageTrack>;
}

export function subscribeNoop(): () => void {
  return () => {};
}

/** Validates and reconstructs a safe manifest URL under an allowed relative `/books/*` path or `https://` origin. */
export function resolveSafeAudioManifestUrl(url: string, basePath: string): string | null {
  if (typeof url !== "string" || url.trim() === "") return null;
  const trimmed = url.trim();
  if (trimmed.includes("..") || trimmed.includes("\\")) return null;
  const cleanBase = basePath.replace(/\/+$/, "");
  if (/^\/[a-z0-9/_-]+$/i.test(cleanBase) && trimmed.startsWith(`${cleanBase}/`)) {
    const match = /^([a-z0-9/_-]+\.json)$/i.exec(trimmed.slice(cleanBase.length + 1));
    return match ? `${cleanBase}/${match[1]}` : null;
  }
  if (trimmed.startsWith("https://") && URL.canParse(trimmed)) {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    if (!/\.json$/i.test(parsed.pathname)) return null;
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  }
  return null;
}

/** Fetches and validates a pre-baked preview audio manifest with AbortController cancellation. */
export function fetchPreviewAudioManifest(
  url: string,
  basePath: string,
  onLoaded: (manifest: PreviewAudioManifest) => void,
): () => void {
  const safeUrl = resolveSafeAudioManifestUrl(url, basePath);
  if (!safeUrl || typeof fetch !== "function") return () => {};
  const controller = new AbortController();
  let cancelled = false;
  fetch(safeUrl, { signal: controller.signal })
    .then((res) => (res.ok ? res.json() : null))
    .then((raw) => {
      if (cancelled) return;
      const parsed = parsePreviewAudioManifest(raw, basePath);
      if (parsed) onLoaded(parsed);
    })
    .catch((err) => {
      if (!cancelled && (err as { name?: string } | null)?.name !== "AbortError") {
        console.warn("[read-aloud] Audio manifest fetch failed, using Web Speech fallback:", err);
      }
    });
  return () => {
    cancelled = true;
    controller.abort();
  };
}

export function detectSpeechSynthesisSupport(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    Boolean(window.speechSynthesis) &&
    typeof window.SpeechSynthesisUtterance === "function"
  );
}

/** True while Web Speech has speech queued, in flight, or paused. */
export function isSpeechEngineBusy(synth: SpeechSynthesis): boolean {
  return Boolean(synth.speaking || synth.pending || synth.paused);
}

/** Cancels queued or active browser Web Speech synthesis safely when busy. */
export function cancelSpeechSynthesisIfBusy(): void {
  if (detectSpeechSynthesisSupport() && isSpeechEngineBusy(window.speechSynthesis)) {
    window.speechSynthesis.cancel?.();
  }
}

/** End offset of the word that starts at charIndex. */
export function wordEndAt(text: string, charIndex: number): number {
  const match = /^\S+/.exec(text.slice(charIndex));
  return charIndex + (match ? match[0].length : 0);
}

export function detectAudioSupport(): boolean {
  return typeof window !== "undefined" && typeof window.Audio === "function";
}

export function isSafeAudioTrackUrl(value: unknown, audioBasePath = "/books/audio"): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  const trimmed = value.trim();
  const base = audioBasePath.replace(/\/+$/, "");
  if (trimmed.includes("..") || trimmed.includes("\\")) return false;
  if (base.startsWith("/") && !base.includes("..") && !base.includes("\\") && trimmed.startsWith(`${base}/`)) {
    return /^[a-z0-9/_-]+\.(?:mp3|wav|ogg|m4a|webm)$/i.test(trimmed.slice(base.length + 1));
  }
  if (trimmed.startsWith("https://") && URL.canParse(trimmed)) {
    const parsedUrl = new URL(trimmed);
    return parsedUrl.protocol === "https:" && !parsedUrl.username && !parsedUrl.password;
  }
  return false;
}

function parseTimingWords(raw: unknown): PreviewAudioTimingWord[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const words: PreviewAudioTimingWord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.start === "number" &&
      Number.isInteger(rec.start) &&
      rec.start >= 0 &&
      typeof rec.end === "number" &&
      Number.isInteger(rec.end) &&
      rec.end > rec.start &&
      typeof rec.startMs === "number" &&
      Number.isFinite(rec.startMs) &&
      rec.startMs >= 0 &&
      typeof rec.endMs === "number" &&
      Number.isFinite(rec.endMs) &&
      rec.endMs > rec.startMs
    ) {
      words.push({ start: rec.start, end: rec.end, startMs: rec.startMs, endMs: rec.endMs });
    }
  }
  if (words.length === 0) return undefined;
  words.sort((a, b) => a.startMs - b.startMs);
  return words;
}

export function parsePreviewAudioManifest(raw: unknown, audioBasePath = "/books/audio"): PreviewAudioManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.version !== 1 || !rec.pages || typeof rec.pages !== "object" || Array.isArray(rec.pages)) {
    return null;
  }
  const pages: Record<string, PreviewAudioPageTrack> = {};
  const seenIds = new Set<string>();
  for (const [pageKey, entry] of Object.entries(rec.pages as Record<string, unknown>)) {
    if (!/^\d+$/.test(pageKey) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const trackRec = entry as Record<string, unknown>;
    if (
      typeof trackRec.pageIndex !== "number" ||
      !Number.isInteger(trackRec.pageIndex) ||
      typeof trackRec.pdfPageNumber !== "number" ||
      !Number.isInteger(trackRec.pdfPageNumber) ||
      !isSafeAudioTrackUrl(trackRec.audioUrl, audioBasePath) ||
      (trackRec.opusUrl !== undefined && !isSafeAudioTrackUrl(trackRec.opusUrl, audioBasePath)) ||
      typeof trackRec.durationMs !== "number" ||
      !Number.isFinite(trackRec.durationMs) ||
      trackRec.durationMs <= 0 ||
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
        seenIds.has(chunkRec.id) ||
        typeof chunkRec.blockIndex !== "number" ||
        typeof chunkRec.text !== "string" ||
        typeof chunkRec.startMs !== "number" ||
        !Number.isFinite(chunkRec.startMs) ||
        chunkRec.startMs < 0 ||
        typeof chunkRec.endMs !== "number" ||
        !Number.isFinite(chunkRec.endMs) ||
        chunkRec.endMs <= chunkRec.startMs
      ) {
        chunksOk = false;
        break;
      }
      seenIds.add(chunkRec.id);
      const words = parseTimingWords(chunkRec.words);
      validChunks.push({
        id: chunkRec.id,
        blockIndex: chunkRec.blockIndex,
        text: chunkRec.text,
        ...(typeof chunkRec.spokenText === "string" ? { spokenText: chunkRec.spokenText } : {}),
        startMs: chunkRec.startMs,
        endMs: chunkRec.endMs,
        ...(typeof chunkRec.tokensCharged === "number" ? { tokensCharged: chunkRec.tokensCharged } : {}),
        ...(words ? { words } : {}),
      });
    }
    if (!chunksOk || validChunks.length === 0) continue;
    validChunks.sort((a, b) => a.startMs - b.startMs);
    pages[pageKey] = {
      pageIndex: trackRec.pageIndex,
      pdfPageNumber: trackRec.pdfPageNumber,
      ...(typeof trackRec.bookPageLabel === "string" ? { bookPageLabel: trackRec.bookPageLabel } : {}),
      audioUrl: trackRec.audioUrl.trim(),
      ...(typeof trackRec.opusUrl === "string" ? { opusUrl: trackRec.opusUrl.trim() } : {}),
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
    ...(rec.voiceGender === "male" || rec.voiceGender === "female" ? { voiceGender: rec.voiceGender } : {}),
    model: typeof rec.model === "string" ? rec.model : "",
    sampleRateHz: typeof rec.sampleRateHz === "number" ? rec.sampleRateHz : 48000,
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

function normalizeChunkText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function matchedTimingChunk(track: PreviewAudioPageTrack, timeSec: number): PreviewAudioTimingChunk | null {
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
  return matched;
}

export function chunkIndexForTrackTime(
  track: PreviewAudioPageTrack,
  timeSec: number,
  allChunks: ReadonlyArray<ReadAloudChunk>,
): number | null {
  const matched = matchedTimingChunk(track, timeSec);
  if (!matched) return null;
  const idx = allChunks.findIndex((chunk) => chunk.id === matched.id);
  return idx >= 0 ? idx : null;
}

export function activeWordForTrackTime(
  track: PreviewAudioPageTrack,
  timeSec: number,
): { chunkId: string; start: number; end: number } | null {
  const matched = matchedTimingChunk(track, timeSec);
  if (!matched) return null;
  const posMs = Math.max(0, timeSec * 1000);
  if (posMs < matched.startMs || posMs > matched.endMs) return null;
  if (matched.words && matched.words.length > 0) {
    let picked = matched.words[0];
    for (let i = 1; i < matched.words.length; i++) {
      if (matched.words[i].startMs <= posMs) picked = matched.words[i];
      else break;
    }
    const end = Math.min(picked.end, matched.text.length);
    return end > picked.start ? { chunkId: matched.id, start: picked.start, end } : null;
  }
  const tokens: Array<{ start: number; end: number; weight: number }> = [];
  let match: RegExpExecArray | null;
  const wordRe = /\S+/g;
  while ((match = wordRe.exec(matched.text)) !== null) {
    tokens.push({ start: match.index, end: match.index + match[0].length, weight: Math.max(1, match[0].length) });
  }
  if (tokens.length === 0) return null;
  const totalWeight = tokens.reduce((acc, token) => acc + token.weight, 0);
  const progressRatio = (posMs - matched.startMs) / Math.max(1, matched.endMs - matched.startMs);
  const targetWeight = progressRatio * totalWeight;
  let running = 0;
  for (const token of tokens) {
    running += token.weight;
    if (running >= targetWeight) return { chunkId: matched.id, start: token.start, end: token.end };
  }
  const lastToken = tokens[tokens.length - 1];
  return { chunkId: matched.id, start: lastToken.start, end: lastToken.end };
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
    const pageChunks = byPage.get(pageIndex) ?? [];
    if (!track || track.chunks.length === 0 || track.chunks.length !== pageChunks.length) return null;
    for (let i = 0; i < pageChunks.length; i++) {
      const expected = pageChunks[i];
      const timed = track.chunks[i];
      if (
        timed.id !== expected.id ||
        timed.blockIndex !== expected.blockIndex ||
        normalizeChunkText(timed.text) !== normalizeChunkText(expected.text)
      ) {
        return null;
      }
    }
    tracks.push(track);
  }
  return tracks.length > 0 ? tracks : null;
}

function supportsOpusWebm(audio: { canPlayType?: (mimeType: string) => string }): boolean {
  if (typeof audio.canPlayType !== "function") return false;
  const codecSupport = audio.canPlayType('audio/webm; codecs="opus"');
  return codecSupport === "probably" || codecSupport === "maybe";
}

export function selectTrackAudioCandidates(
  track: PreviewAudioPageTrack,
  audio: { canPlayType?: (mimeType: string) => string },
): string[] {
  const candidates: string[] = [];
  const opusSupported = supportsOpusWebm(audio);
  const addCandidate = (url: string | undefined) => {
    if (!url || candidates.includes(url)) return;
    if (/\.webm(?:$|\?)/i.test(url) && !opusSupported) return;
    candidates.push(url);
  };
  addCandidate(track.opusUrl);
  addCandidate(track.audioUrl);
  return candidates;
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
