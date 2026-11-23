import type { ReadAloudChunk } from "./book-previewer-text";
import { chunkIndexForTrackTime, type PreviewAudioPageTrack, type PreviewAudioTimingChunk } from "./read-aloud-audio";

/** The word being spoken, as char offsets into its sentence chunk. Only set when highlight_words is on. */
export interface ReadAloudWord {
  chunkId: string;
  start: number;
  end: number;
}

export interface UseReadAloudOptions {
  /** Called when playback naturally reaches the end of the visible spread; returns true if a page turn started. */
  onRequestNextPage?: () => boolean;
}

export interface SavedSpreadPosition {
  chunkId: string;
  chunkIdx: number;
  timeSec: number;
  charIndex: number;
}

export interface PendingSeekPosition {
  chunkId: string;
  chunkIdx: number;
  timeSec: number;
}

export interface LiveSpreadPosition extends SavedSpreadPosition {
  key: string;
}

export type SpreadStartResolution =
  | { source: "carryover"; chunkId: string; chunkIdx: number; timeSec: number; charIndex: number }
  | { source: "saved"; chunkId: string; chunkIdx: number; timeSec: number; charIndex: number }
  | { source: "top"; chunkId: string | null; chunkIdx: number; timeSec: number; charIndex: number };

export function clampedChunkSeekSec(timingChunk: PreviewAudioTimingChunk, seekSec: number): number {
  const minSec = timingChunk.startMs / 1000;
  const maxSec = timingChunk.endMs / 1000;
  return seekSec >= minSec && seekSec <= maxSec ? seekSec : minSec;
}

/** Finds the pre-baked page track and timing entry containing `chunkId`. */
export function locateChunkInTracks(
  tracks: ReadonlyArray<PreviewAudioPageTrack> | null,
  chunkId: string,
): { trackIdx: number; track: PreviewAudioPageTrack; timingChunk: PreviewAudioTimingChunk } | null {
  if (!tracks) return null;
  for (let trackIdx = 0; trackIdx < tracks.length; trackIdx++) {
    const track = tracks[trackIdx];
    const timingChunk = track.chunks.find((chunk) => chunk.id === chunkId);
    if (timingChunk) return { trackIdx, track, timingChunk };
  }
  return null;
}

/** Computes outer spacer and CSS transform styles when preview zoom > 1. */
export function computeZoomViewportStyles(zoom: number, stageSize: { w: number; h: number }) {
  if (zoom <= 1) return { isZoomed: false, spacerStyle: undefined, innerStyle: undefined };
  const hasSize = stageSize.w > 0 && stageSize.h > 0;
  return {
    isZoomed: true,
    spacerStyle: hasSize ? { width: `${Math.round(stageSize.w * zoom)}px`, height: `${Math.round(stageSize.h * zoom)}px` } : undefined,
    innerStyle: { transform: `scale(${zoom})`, transformOrigin: "top left" as const, ...(hasSize ? { width: `${stageSize.w}px`, height: `${stageSize.h}px` } : {}) },
  };
}

/** Returns the pageIndex of the active chunk while playback is active or paused, or null when idle. */
export function resolveActiveChunkPageIndex(
  chunks: ReadonlyArray<ReadAloudChunk>,
  activeChunkId: string | null,
  playbackState: "idle" | "playing" | "paused",
): number | null {
  if (!activeChunkId || playbackState === "idle") return null;
  return chunks.find((chunk) => chunk.id === activeChunkId)?.pageIndex ?? null;
}

/**
 * Resolves where playback should stand when the visible chunk set changes:
 * 1) If the currently active chunk still exists in the new spread (e.g. orientation shift), carry it over.
 * 2) Otherwise, if this spread has a saved resume position, restore it.
 * 3) Otherwise, start at the top of the spread.
 */
export function resolveNextSpreadStart(
  chunks: ReadonlyArray<ReadAloudChunk>,
  livePos: LiveSpreadPosition | null,
  savedPos: SavedSpreadPosition | undefined,
): SpreadStartResolution {
  if (livePos) {
    const carryoverIdx = chunks.findIndex((chunk) => chunk.id === livePos.chunkId);
    if (carryoverIdx >= 0) {
      return {
        source: "carryover",
        chunkId: livePos.chunkId,
        chunkIdx: carryoverIdx,
        timeSec: livePos.timeSec,
        charIndex: livePos.charIndex,
      };
    }
  }
  if (savedPos) {
    const savedIdx = chunks.findIndex((chunk) => chunk.id === savedPos.chunkId);
    if (savedIdx >= 0) {
      return {
        source: "saved",
        chunkId: savedPos.chunkId,
        chunkIdx: savedIdx,
        timeSec: savedPos.timeSec,
        charIndex: savedPos.charIndex,
      };
    }
  }
  return {
    source: "top",
    chunkId: chunks[0]?.id ?? null,
    chunkIdx: 0,
    timeSec: 0,
    charIndex: 0,
  };
}

/** Resolves the current audio or speech playback snapshot for persistence across Pause or tab backgrounding. */
export function captureSpreadPlaybackPosition(
  engine: "none" | "audio" | "speech",
  audio: HTMLAudioElement | null,
  activeTrack: PreviewAudioPageTrack | null,
  speechPos: { idx: number; charIndex: number } | null,
  activeChunkIdx: number | null,
  chunks: ReadonlyArray<ReadAloudChunk>,
  pendingSeek?: PendingSeekPosition | null,
): SavedSpreadPosition | null {
  if (engine === "audio" && audio) {
    if (pendingSeek) {
      return { chunkId: pendingSeek.chunkId, chunkIdx: pendingSeek.chunkIdx, timeSec: pendingSeek.timeSec, charIndex: 0 };
    }
    const resolvedIdx = (activeTrack ? chunkIndexForTrackTime(activeTrack, audio.currentTime, chunks) : activeChunkIdx) ?? activeChunkIdx ?? 0;
    const chunk = chunks[resolvedIdx];
    return chunk ? { chunkId: chunk.id, chunkIdx: resolvedIdx, timeSec: audio.currentTime, charIndex: 0 } : null;
  }
  if (engine === "speech") {
    const resolvedIdx = speechPos?.idx ?? activeChunkIdx ?? 0;
    const chunk = chunks[resolvedIdx];
    return chunk ? { chunkId: chunk.id, chunkIdx: resolvedIdx, timeSec: 0, charIndex: speechPos?.charIndex ?? 0 } : null;
  }
  return null;
}
