import type { BookPreviewReadAloudSettings } from "../../../../payments/src/settings_registry";
import type { ReadAloudChunk } from "./book-previewer-text";
import {
  activeWordForTrackTime,
  applyAudioPlaybackRate,
  chunkIndexForTrackTime,
  detectSpeechSynthesisSupport,
  isSpeechEngineBusy,
  playAudioWithErrorHandler,
  selectTrackAudioCandidates,
  wordEndAt,
  type PreviewAudioPageTrack,
} from "./read-aloud-audio";
import type { PendingSeekPosition, ReadAloudWord } from "./read-aloud-state";

export interface AudioQueueState {
  tracks: PreviewAudioPageTrack[];
  trackIdx: number;
  candidates: string[];
  candidateIdx: number;
  pendingSeek?: PendingSeekPosition | null;
}

/** Stops HTMLAudioElement playback cleanly and optionally clears src + cached source URL. */
export function teardownAudioElement(
  audio: HTMLAudioElement | null,
  clearSrc: boolean,
  onClearedSrc?: () => void,
): void {
  if (!audio) return;
  audio.onloadedmetadata = null;
  audio.ontimeupdate = null;
  audio.onended = null;
  audio.onerror = null;
  try {
    audio.pause();
    audio.currentTime = 0;
    if (clearSrc) {
      onClearedSrc?.();
      audio.removeAttribute("src");
      audio.load?.();
    }
  } catch (err) {
    console.warn("[read-aloud] Audio teardown warning:", err);
  }
}

/** Computes Web Speech fallback character offset, skipping any already-spoken landmark prefix past 0.4s into the chunk. */
function computeFallbackCharOffset(
  track: PreviewAudioPageTrack | undefined,
  chunkIdx: number,
  chunks: ReadonlyArray<ReadAloudChunk>,
  currentTimeSec: number,
): number {
  const chunk = chunks[chunkIdx];
  if (!track || !chunk) return 0;
  const spokenText = chunk.spokenText ?? chunk.text;
  const prefixLen = spokenText.endsWith(chunk.text) ? spokenText.length - chunk.text.length : 0;
  if (prefixLen <= 0) return 0;
  const timingChunk = track.chunks.find((c) => c.id === chunk.id);
  if (!timingChunk) return 0;
  return currentTimeSec > timingChunk.startMs / 1000 + 0.4 ? prefixLen : 0;
}

/** Resumes a paused HTMLAudioElement at `rate`, falling back to Web Speech at the active chunk on error. */
export function resumeAudioElement(
  audio: HTMLAudioElement,
  queue: AudioQueueState,
  chunks: ReadonlyArray<ReadAloudChunk>,
  rate: number,
  isStale: () => boolean,
  onFallbackSpeech: (chunkIdx: number, charOffset?: number) => void,
  onHardStop: () => void,
): void {
  applyAudioPlaybackRate(audio, rate);
  playAudioWithErrorHandler(audio, () => {
    if (isStale()) return;
    const track = queue.tracks[queue.trackIdx];
    const timedIdx = track ? chunkIndexForTrackTime(track, audio.currentTime, chunks) : null;
    const fallbackIdx = track ? chunks.findIndex((chunk) => chunk.pageIndex === track.pageIndex) : 0;
    const resolvedIdx = timedIdx ?? (fallbackIdx >= 0 ? fallbackIdx : 0);
    if (detectSpeechSynthesisSupport()) {
      onFallbackSpeech(resolvedIdx, computeFallbackCharOffset(track, resolvedIdx, chunks, audio.currentTime));
    } else {
      onHardStop();
    }
  });
}

export interface SpeechSessionCallbacks {
  chunks: ReadonlyArray<ReadAloudChunk>;
  chunkKey: string;
  rate: number;
  voice: SpeechSynthesisVoice | null;
  highlightWords: boolean;
  isStale: () => boolean;
  onStartChunk: (idx: number, fromChar: number) => void;
  onBoundary: (idx: number, charIndex: number, word: ReadAloudWord | null) => void;
  onFinishSpread: () => void;
  onError: () => void;
}

/** Speaks chunks sequentially via Web Speech API starting at `startIdx`/`startCharIndex`. */
export function runWebSpeechSequence(
  startIdx: number,
  startCharIndex: number,
  cb: SpeechSessionCallbacks,
): void {
  const synth = window.speechSynthesis;
  if (isSpeechEngineBusy(synth)) synth.cancel?.();
  if (synth.paused) synth.resume?.();

  const speakChunk = (idx: number, fromChar: number) => {
    if (cb.isStale()) return;
    if (idx >= cb.chunks.length) {
      cb.onFinishSpread();
      return;
    }
    const chunk = cb.chunks[idx];
    const spokenText = chunk.spokenText ?? chunk.text;
    const prefixLen = spokenText.endsWith(chunk.text) ? spokenText.length - chunk.text.length : 0;
    const UtteranceCtor = window.SpeechSynthesisUtterance;
    const utterance = new UtteranceCtor(spokenText.slice(fromChar));
    utterance.rate = cb.rate;
    if (cb.voice) {
      utterance.voice = cb.voice;
      utterance.lang = cb.voice.lang;
    }
    cb.onStartChunk(idx, fromChar);
    utterance.onstart = () => {
      if (!cb.isStale()) cb.onStartChunk(idx, fromChar);
    };
    utterance.onboundary = (event) => {
      if (cb.isStale() || typeof event.charIndex !== "number") return;
      const charIndex = fromChar + event.charIndex;
      const uiCharIndex = charIndex - prefixLen;
      const word =
        cb.highlightWords && uiCharIndex >= 0 && uiCharIndex < chunk.text.length
          ? { chunkId: chunk.id, start: uiCharIndex, end: wordEndAt(chunk.text, uiCharIndex) }
          : null;
      cb.onBoundary(idx, charIndex, word);
    };
    utterance.onend = () => {
      if (!cb.isStale()) speakChunk(idx + 1, 0);
    };
    utterance.onerror = () => {
      if (!cb.isStale()) cb.onError();
    };
    synth.speak(utterance);
  };

  speakChunk(startIdx, startCharIndex);
}

export interface AudioTrackSessionCallbacks {
  audio: HTMLAudioElement;
  tracks: PreviewAudioPageTrack[];
  startTrackIdx: number;
  initialSeekSec: number;
  initialChunkIdx?: number;
  chunks: ReadonlyArray<ReadAloudChunk>;
  raSettings: BookPreviewReadAloudSettings;
  getRate: () => number;
  getCurrentSource: () => string | null;
  setCurrentSource: (url: string | null) => void;
  setQueue: (queue: AudioQueueState | null) => void;
  isStale: () => boolean;
  onChunkActive: (idx: number, timeSec: number) => void;
  onWordChange: (word: ReadAloudWord | null) => void;
  onFinishSpread: () => void;
  onFallbackSpeech: (chunkIdx: number, charOffset?: number) => void;
  onHardStop: () => void;
}

function setAudioTimeSafely(audio: HTMLAudioElement, timeSec: number): void {
  try {
    audio.currentTime = timeSec;
  } catch (err) {
    // Browsers throw InvalidStateError when setting currentTime before metadata arrives; onloadedmetadata re-applies it.
    if ((err as { name?: string } | null)?.name !== "InvalidStateError") {
      console.warn("[read-aloud] Audio seek deferred:", err);
    }
  }
}

/** Plays pre-baked page audio tracks sequentially with codec fallback, seek accuracy, and Web Speech recovery. */
export function runPrebakedTrackQueue(cb: AudioTrackSessionCallbacks): void {
  const { audio, tracks, startTrackIdx, initialSeekSec, initialChunkIdx, chunks, raSettings } = cb;

  const startTrack = (trackIdx: number, candidateIdx = 0, retrySeekSec?: number) => {
    if (cb.isStale()) return;
    const track = tracks[trackIdx];
    if (!track) {
      cb.onFinishSpread();
      return;
    }
    const candidates = selectTrackAudioCandidates(track, audio);
    const sourceUrl = candidates[candidateIdx];
    const seekSec =
      retrySeekSec !== undefined
        ? Math.max(0, retrySeekSec)
        : trackIdx === startTrackIdx
          ? Math.max(0, initialSeekSec)
          : 0;
    const initialIdx =
      retrySeekSec === undefined && trackIdx === startTrackIdx && initialChunkIdx !== undefined
        ? initialChunkIdx
        : chunkIndexForTrackTime(track, seekSec, chunks);
    let currentChunkIdx: number | null = initialIdx;

    if (!sourceUrl) {
      const fallbackIdx = chunks.findIndex((chunk) => chunk.pageIndex === track.pageIndex);
      if (detectSpeechSynthesisSupport()) {
        cb.onFallbackSpeech(currentChunkIdx ?? (fallbackIdx >= 0 ? fallbackIdx : 0));
      } else {
        cb.onHardStop();
      }
      return;
    }

    let handledFailure = false;
    let pendingSeekSec: number | null = seekSec > 0 ? seekSec : null;
    const pendingChunk = initialIdx !== null ? chunks[initialIdx] : undefined;
    const queueState: AudioQueueState = {
      tracks,
      trackIdx,
      candidates,
      candidateIdx,
      pendingSeek:
        pendingSeekSec !== null && initialIdx !== null && pendingChunk
          ? { chunkId: pendingChunk.id, chunkIdx: initialIdx, timeSec: pendingSeekSec }
          : null,
    };
    cb.setQueue(queueState);
    if (initialIdx !== null) cb.onChunkActive(initialIdx, seekSec);

    const syncWordForTime = (timeSec: number) => {
      cb.onWordChange(raSettings.highlight_words ? activeWordForTrackTime(track, timeSec) : null);
    };
    syncWordForTime(seekSec);
    const handleSourceFailure = (reason: unknown) => {
      if (cb.isStale() || handledFailure) return;
      handledFailure = true;
      const resumeSeekSec =
        pendingSeekSec !== null
          ? pendingSeekSec
          : audio.currentTime > 0
            ? audio.currentTime
            : seekSec;
      if (candidateIdx + 1 < candidates.length) {
        console.warn("[read-aloud] Audio source failed, falling back to secondary codec:", sourceUrl, reason);
        startTrack(trackIdx, candidateIdx + 1, resumeSeekSec);
        return;
      }
      console.warn("[read-aloud] Audio playback error, falling back to Web Speech:", reason);
      const timedIdx = pendingSeekSec === null ? chunkIndexForTrackTime(track, audio.currentTime, chunks) : null;
      const fallbackIdx = chunks.findIndex((chunk) => chunk.pageIndex === track.pageIndex);
      const resolvedIdx = timedIdx ?? currentChunkIdx ?? (fallbackIdx >= 0 ? fallbackIdx : 0);
      if (detectSpeechSynthesisSupport()) {
        const refTimeSec = pendingSeekSec === null ? audio.currentTime : pendingSeekSec;
        cb.onFallbackSpeech(resolvedIdx, computeFallbackCharOffset(track, resolvedIdx, chunks, refTimeSec));
      } else {
        cb.onHardStop();
      }
    };

    audio.onloadedmetadata = () => {
      if (cb.isStale()) return;
      applyAudioPlaybackRate(audio, cb.getRate());
      if (pendingSeekSec !== null) {
        const target = pendingSeekSec;
        pendingSeekSec = null;
        setAudioTimeSafely(audio, target);
        if (Math.abs(audio.currentTime - target) <= 0.15) queueState.pendingSeek = null;
      }
    };
    audio.ontimeupdate = () => {
      if (cb.isStale()) return;
      if (pendingSeekSec !== null) {
        if (audio.currentTime < pendingSeekSec - 0.15) return;
        pendingSeekSec = null;
      }
      queueState.pendingSeek = null;
      const nextIdx = chunkIndexForTrackTime(track, audio.currentTime, chunks);
      if (nextIdx !== null) {
        currentChunkIdx = nextIdx;
        cb.onChunkActive(nextIdx, audio.currentTime);
      }
      syncWordForTime(audio.currentTime);
    };
    audio.onended = () => {
      if (!cb.isStale()) startTrack(trackIdx + 1, 0, 0);
    };
    audio.onerror = () => handleSourceFailure("HTMLAudioElement error event");

    const sameLoadedTrack = cb.getCurrentSource() === sourceUrl && (audio.readyState ?? 0) >= 1;
    applyAudioPlaybackRate(audio, cb.getRate());
    if (sameLoadedTrack) {
      pendingSeekSec = null;
      if (Math.abs(audio.currentTime - seekSec) > 0.05) {
        setAudioTimeSafely(audio, seekSec);
      }
      if (Math.abs(audio.currentTime - seekSec) <= 0.15) queueState.pendingSeek = null;
    } else {
      audio.preload = "none";
      audio.src = sourceUrl;
      cb.setCurrentSource(sourceUrl);
      applyAudioPlaybackRate(audio, cb.getRate());
      setAudioTimeSafely(audio, seekSec);
      if (Math.abs(audio.currentTime - seekSec) <= 0.15) queueState.pendingSeek = null;
    }
    playAudioWithErrorHandler(audio, (err) => handleSourceFailure(err));
  };

  startTrack(startTrackIdx);
}
