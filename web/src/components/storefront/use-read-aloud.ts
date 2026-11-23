"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BookPreviewReadAloudSettings } from "../../../../payments/src/settings_registry";
import type { ReadAloudChunk } from "./book-previewer-text";
import type { ReadAloudState } from "./book-preview-accessible-card";
import { rankVoice } from "./read-aloud-voice";
import {
  applyAudioPlaybackRate,
  chunkIndexForTrackTime,
  detectAudioSupport,
  detectSpeechSynthesisSupport,
  isSpeechEngineBusy,
  parsePreviewAudioManifest,
  resolveSpreadAudioTracks,
  subscribeNoop,
  type PreviewAudioManifest,
} from "./read-aloud-audio";
import {
  clampedChunkSeekSec,
  locateChunkInTracks,
  resolveNextSpreadStart,
  type LiveSpreadPosition,
  type ReadAloudWord,
  type SavedSpreadPosition,
  type UseReadAloudOptions,
} from "./read-aloud-state";
import {
  resumeAudioElement,
  runPrebakedTrackQueue,
  runWebSpeechSequence,
  teardownAudioElement,
  type AudioQueueState,
} from "./read-aloud-engines";

export { detectSpeechSynthesisSupport, type ReadAloudWord, type UseReadAloudOptions };

/**
 * Sentence-chunk Read Aloud: prefers pre-baked narrated Opus WebM + timing manifest when available
 * (instant start, $0 runtime cost, pitch-preserved speed changes via HTML5 <audio>), and falls
 * back transparently to browser Web Speech when no audio manifest is present or audio fails.
 */
export function useReadAloud(
  chunks: ReadAloudChunk[],
  raSettings: BookPreviewReadAloudSettings,
  onExpandPanel: () => void,
  audioManifestUrl?: string | null,
  audioBasePath = "/books/audio",
  options?: UseReadAloudOptions,
) {
  const [playbackState, setPlaybackState] = useState<ReadAloudState>("idle");
  const [usingFallbackVoice, setUsingFallbackVoice] = useState(false);
  const [activeChunk, setActiveChunk] = useState<{ idx: number; key: string } | null>(null);
  const chunkKey = useMemo(() => chunks.map((chunk) => chunk.id).join("|"), [chunks]);
  const activeChunkIdx = activeChunk && activeChunk.key === chunkKey ? activeChunk.idx : null;
  const [activeWord, setActiveWord] = useState<ReadAloudWord | null>(null);
  const [rateIdx, setRateIdx] = useState(() => {
    const idx = raSettings.rates.indexOf(raSettings.default_rate);
    return idx >= 0 ? idx : 0;
  });
  const [speechAnnouncement, setSpeechAnnouncement] = useState("");
  const [loadedManifest, setLoadedManifest] = useState<{
    url: string;
    basePath: string;
    manifest: PreviewAudioManifest;
  } | null>(null);

  const speechSessionRef = useRef(0);
  const pausedAtRateRef = useRef<number | null>(null);
  const positionRef = useRef<{ idx: number; charIndex: number } | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentAudioSourceRef = useRef<string | null>(null);
  const activeEngineRef = useRef<"none" | "audio" | "speech">("none");
  const audioQueueRef = useRef<AudioQueueState | null>(null);
  const chunkKeyRef = useRef(chunkKey);
  const onRequestNextPageRef = useRef(options?.onRequestNextPage);
  const savedPositionsRef = useRef<Map<string, SavedSpreadPosition>>(new Map());
  const livePositionRef = useRef<LiveSpreadPosition | null>(null);

  const speechSupported = useSyncExternalStore(subscribeNoop, detectSpeechSynthesisSupport, () => false);
  const audioElementSupported = useSyncExternalStore(subscribeNoop, detectAudioSupport, () => false);

  const raRates = useMemo(
    () => (raSettings.rates.length > 0 ? raSettings.rates : [raSettings.default_rate]),
    [raSettings.rates, raSettings.default_rate],
  );
  const safeRateIdx = Math.min(Math.max(0, rateIdx), raRates.length - 1);
  const currentRate = raRates[safeRateIdx] ?? raSettings.default_rate;
  const rateRef = useRef(currentRate);

  useEffect(() => {
    rateRef.current = currentRate;
  }, [currentRate]);
  useEffect(() => {
    chunkKeyRef.current = chunkKey;
  }, [chunkKey]);
  useEffect(() => {
    onRequestNextPageRef.current = options?.onRequestNextPage;
  }, [options?.onRequestNextPage]);

  useEffect(() => {
    if (!raSettings.enabled || !audioManifestUrl || typeof fetch !== "function") return;
    const controller = new AbortController();
    let cancelled = false;
    fetch(audioManifestUrl, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((raw) => {
        if (cancelled) return;
        const parsed = parsePreviewAudioManifest(raw, audioBasePath);
        if (parsed) setLoadedManifest({ url: audioManifestUrl, basePath: audioBasePath, manifest: parsed });
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
  }, [raSettings.enabled, audioManifestUrl, audioBasePath]);

  const manifest =
    audioManifestUrl && loadedManifest?.url === audioManifestUrl && loadedManifest.basePath === audioBasePath
      ? loadedManifest.manifest
      : null;
  const prebakedTracks = useMemo(() => resolveSpreadAudioTracks(manifest, chunks), [manifest, chunks]);
  const preferredGender = manifest?.voiceGender ?? (audioManifestUrl ? "male" : null);
  const audioSupported = Boolean(audioElementSupported && prebakedTracks);
  const readAloudSupported = audioSupported || speechSupported;
  const activeChunkId = activeChunkIdx !== null ? (chunks[activeChunkIdx]?.id ?? null) : null;

  const recordPosition = useCallback((key: string, chunkId: string, chunkIdx: number, timeSec: number, charIndex: number) => {
    const entry: SavedSpreadPosition = { chunkId, chunkIdx, timeSec, charIndex };
    savedPositionsRef.current.set(key, entry);
    livePositionRef.current = { key, ...entry };
  }, []);

  const stopAudioEngine = useCallback((clearSrc: boolean) => {
    audioQueueRef.current = null;
    teardownAudioElement(audioRef.current, clearSrc, () => {
      currentAudioSourceRef.current = null;
    });
  }, []);

  const cancelSpeechEngine = useCallback(() => {
    speechSessionRef.current += 1;
    pausedAtRateRef.current = null;
    positionRef.current = null;
    activeEngineRef.current = "none";
    setUsingFallbackVoice(false);
    stopAudioEngine(false);
    if (detectSpeechSynthesisSupport() && isSpeechEngineBusy(window.speechSynthesis)) {
      window.speechSynthesis.cancel?.();
    }
  }, [stopAudioEngine]);

  const stopReadAloud = useCallback(() => {
    cancelSpeechEngine();
    savedPositionsRef.current.delete(chunkKeyRef.current);
    livePositionRef.current = null;
    setUsingFallbackVoice(false);
    setPlaybackState("idle");
    setActiveChunk(null);
    setActiveWord(null);
  }, [cancelSpeechEngine]);

  const finishSpreadPlayback = useCallback(() => {
    savedPositionsRef.current.delete(chunkKeyRef.current);
    livePositionRef.current = null;
    pausedAtRateRef.current = null;
    positionRef.current = null;
    activeEngineRef.current = "none";
    audioQueueRef.current = null;
    setActiveWord(null);
    if (raSettings.continue_on_page_turn && onRequestNextPageRef.current?.()) {
      setActiveChunk(null);
      setSpeechAnnouncement("");
      return;
    }
    setUsingFallbackVoice(false);
    setPlaybackState("idle");
    setActiveChunk(null);
    setSpeechAnnouncement(raSettings.labels.finished_announcement);
  }, [raSettings.continue_on_page_turn, raSettings.labels.finished_announcement]);

  const clearAnnouncement = useCallback(() => setSpeechAnnouncement(""), []);

  useEffect(() => {
    const onStop = () => stopReadAloud();
    const onVis = () => {
      if (document.visibilityState === "hidden") stopReadAloud();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onStop);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onStop);
      speechSessionRef.current += 1;
      activeEngineRef.current = "none";
      stopAudioEngine(true);
      if (detectSpeechSynthesisSupport() && isSpeechEngineBusy(window.speechSynthesis)) {
        window.speechSynthesis.cancel?.();
      }
    };
  }, [stopReadAloud, stopAudioEngine]);

  useEffect(() => {
    if (!detectSpeechSynthesisSupport()) return;
    const synth = window.speechSynthesis;
    const chooseVoice = () => {
      voiceRef.current = rankVoice(synth.getVoices?.() ?? [], raSettings.voice, preferredGender);
    };
    chooseVoice();
    synth.addEventListener?.("voiceschanged", chooseVoice);
    return () => synth.removeEventListener?.("voiceschanged", chooseVoice);
  }, [raSettings.voice, preferredGender]);

  const speakFromIndex = useCallback(
    (startIdx: number, startCharIndex: number, rate: number) => {
      if (!detectSpeechSynthesisSupport() || startIdx < 0 || startIdx >= chunks.length) {
        stopReadAloud();
        return;
      }
      stopAudioEngine(false);
      const session = ++speechSessionRef.current;
      activeEngineRef.current = "speech";
      setUsingFallbackVoice(Boolean(audioManifestUrl));
      pausedAtRateRef.current = null;
      setSpeechAnnouncement("");
      setPlaybackState("playing");
      const voice = voiceRef.current ?? rankVoice(window.speechSynthesis.getVoices?.() ?? [], raSettings.voice, preferredGender);
      runWebSpeechSequence(startIdx, startCharIndex, {
        chunks,
        chunkKey,
        rate,
        voice,
        highlightWords: raSettings.highlight_words,
        isStale: () => speechSessionRef.current !== session,
        onStartChunk: (idx, fromChar) => {
          positionRef.current = { idx, charIndex: fromChar };
          if (chunks[idx]) recordPosition(chunkKey, chunks[idx].id, idx, 0, fromChar);
          setActiveChunk({ idx, key: chunkKey });
          setActiveWord(null);
        },
        onBoundary: (idx, charIndex, word) => {
          positionRef.current = { idx, charIndex };
          if (chunks[idx]) recordPosition(chunkKey, chunks[idx].id, idx, 0, charIndex);
          if (word) setActiveWord(word);
        },
        onFinishSpread: finishSpreadPlayback,
        onError: () => {
          pausedAtRateRef.current = null;
          positionRef.current = null;
          activeEngineRef.current = "none";
          setUsingFallbackVoice(false);
          setPlaybackState("idle");
          setActiveChunk(null);
          setActiveWord(null);
        },
      });
    },
    [chunks, chunkKey, stopReadAloud, stopAudioEngine, finishSpreadPlayback, recordPosition, raSettings.voice, raSettings.highlight_words, preferredGender, audioManifestUrl],
  );

  const playPrebakedTracks = useCallback(
    (tracks: NonNullable<typeof prebakedTracks>, startTrackIdx: number, rate: number, initialSeekSec = 0, initialChunkIdx?: number) => {
      if (!detectAudioSupport() || tracks.length === 0) {
        if (detectSpeechSynthesisSupport()) speakFromIndex(initialChunkIdx ?? 0, 0, rate);
        else stopReadAloud();
        return;
      }
      if (detectSpeechSynthesisSupport() && isSpeechEngineBusy(window.speechSynthesis)) {
        window.speechSynthesis.cancel?.();
      }
      const session = ++speechSessionRef.current;
      const audio = audioRef.current ?? new window.Audio();
      audioRef.current = audio;
      pausedAtRateRef.current = null;
      positionRef.current = null;
      rateRef.current = rate;
      setSpeechAnnouncement("");
      setPlaybackState("playing");
      setActiveWord(null);
      runPrebakedTrackQueue({
        audio,
        tracks,
        startTrackIdx,
        initialSeekSec,
        initialChunkIdx,
        chunks,
        raSettings,
        getRate: () => rateRef.current,
        getCurrentSource: () => currentAudioSourceRef.current,
        setCurrentSource: (url) => { currentAudioSourceRef.current = url; },
        setQueue: (queue) => {
          audioQueueRef.current = queue;
          if (queue) {
            activeEngineRef.current = "audio";
            setUsingFallbackVoice(false);
          }
        },
        isStale: () => speechSessionRef.current !== session,
        onChunkActive: (idx, timeSec) => {
          if (chunks[idx]) recordPosition(chunkKey, chunks[idx].id, idx, timeSec, 0);
          setActiveChunk((prev) => (prev?.key === chunkKey && prev.idx === idx ? prev : { idx, key: chunkKey }));
        },
        onWordChange: (nextWord) => {
          setActiveWord((prev) => (prev?.chunkId === nextWord?.chunkId && prev?.start === nextWord?.start && prev?.end === nextWord?.end ? prev : nextWord));
        },
        onFinishSpread: finishSpreadPlayback,
        onFallbackSpeech: (idx) => speakFromIndex(idx, 0, rateRef.current),
        onHardStop: stopReadAloud,
      });
    },
    [chunks, chunkKey, raSettings, finishSpreadPlayback, recordPosition, speakFromIndex, stopReadAloud],
  );

  const startAtChunk = useCallback(
    (chunkIdx: number, seekSec: number, charIndex: number, rate: number) => {
      const targetChunk = chunks[chunkIdx];
      if (!targetChunk) return;
      if (prebakedTracks && detectAudioSupport()) {
        const loc = locateChunkInTracks(prebakedTracks, targetChunk.id);
        if (loc) {
          playPrebakedTracks(prebakedTracks, loc.trackIdx, rate, clampedChunkSeekSec(loc.timingChunk, seekSec), chunkIdx);
          return;
        }
      }
      speakFromIndex(chunkIdx, charIndex, rate);
    },
    [chunks, prebakedTracks, playPrebakedTracks, speakFromIndex],
  );

  const startFromSavedOrTop = useCallback(
    (rate: number) => {
      const saved = savedPositionsRef.current.get(chunkKey);
      const savedIdx = saved ? chunks.findIndex((chunk) => chunk.id === saved.chunkId) : -1;
      if (saved && savedIdx >= 0) {
        startAtChunk(savedIdx, saved.timeSec, saved.charIndex, rate);
      } else if (prebakedTracks && detectAudioSupport()) {
        playPrebakedTracks(prebakedTracks, 0, rate, 0);
      } else {
        speakFromIndex(0, 0, rate);
      }
    },
    [chunkKey, chunks, prebakedTracks, playPrebakedTracks, speakFromIndex, startAtChunk],
  );

  const resumeFromPosition = useCallback(
    (rate: number) => {
      const pos = positionRef.current;
      const idx = pos?.idx ?? activeChunkIdx ?? 0;
      const live = livePositionRef.current;
      if (activeEngineRef.current !== "speech" && prebakedTracks && detectAudioSupport()) {
        const chunk = chunks[idx];
        const loc = chunk ? locateChunkInTracks(prebakedTracks, chunk.id) : null;
        if (loc) {
          const seekSec = live && live.chunkId === chunk.id ? clampedChunkSeekSec(loc.timingChunk, live.timeSec) : loc.timingChunk.startMs / 1000;
          playPrebakedTracks(prebakedTracks, loc.trackIdx, rate, seekSec, idx);
          return;
        }
      }
      speakFromIndex(idx, pos && pos.idx === idx ? pos.charIndex : 0, rate);
    },
    [activeChunkIdx, chunks, prebakedTracks, playPrebakedTracks, speakFromIndex],
  );

  const playFromChunk = useCallback(
    (chunkId: string) => {
      if (!raSettings.enabled || !readAloudSupported || chunks.length === 0) return;
      const chunkIdx = chunks.findIndex((chunk) => chunk.id === chunkId);
      if (chunkIdx < 0) return;
      const loc = locateChunkInTracks(prebakedTracks, chunkId);
      const seekSec = loc ? loc.timingChunk.startMs / 1000 : 0;
      recordPosition(chunkKey, chunkId, chunkIdx, seekSec, 0);
      startAtChunk(chunkIdx, seekSec, 0, rateRef.current);
      onExpandPanel();
    },
    [raSettings.enabled, readAloudSupported, chunks, prebakedTracks, recordPosition, chunkKey, startAtChunk, onExpandPanel],
  );

  const handlePlayPauseResume = useCallback(() => {
    if (!raSettings.enabled || !readAloudSupported || chunks.length === 0) return;
    if (playbackState === "idle") {
      startFromSavedOrTop(currentRate);
      onExpandPanel();
      return;
    }
    if (playbackState === "playing") {
      setPlaybackState("paused");
      pausedAtRateRef.current = currentRate;
      if (activeEngineRef.current === "audio" && audioRef.current) {
        const audio = audioRef.current;
        const track = audioQueueRef.current?.tracks[audioQueueRef.current.trackIdx] ?? null;
        const resolvedIdx = (track ? chunkIndexForTrackTime(track, audio.currentTime, chunks) : activeChunkIdx) ?? activeChunkIdx ?? 0;
        if (chunks[resolvedIdx]) recordPosition(chunkKey, chunks[resolvedIdx].id, resolvedIdx, audio.currentTime, 0);
        audio.pause();
      } else {
        const idx = positionRef.current?.idx ?? activeChunkIdx ?? 0;
        if (chunks[idx]) recordPosition(chunkKey, chunks[idx].id, idx, 0, positionRef.current?.charIndex ?? 0);
        window.speechSynthesis.pause?.();
      }
      return;
    }
    if (activeEngineRef.current === "audio" && audioRef.current && audioQueueRef.current) {
      const session = speechSessionRef.current;
      setPlaybackState("playing");
      pausedAtRateRef.current = null;
      rateRef.current = currentRate;
      resumeAudioElement(audioRef.current, audioQueueRef.current, chunks, currentRate, () => speechSessionRef.current !== session, (idx) => speakFromIndex(idx, 0, currentRate), stopReadAloud);
      return;
    }
    if (activeEngineRef.current === "none") {
      startFromSavedOrTop(currentRate);
      return;
    }
    if (window.speechSynthesis.paused && pausedAtRateRef.current === currentRate) {
      setPlaybackState("playing");
      pausedAtRateRef.current = null;
      window.speechSynthesis.resume?.();
      return;
    }
    resumeFromPosition(currentRate);
  }, [raSettings.enabled, readAloudSupported, chunks, chunkKey, activeChunkIdx, playbackState, startFromSavedOrTop, currentRate, onExpandPanel, recordPosition, speakFromIndex, stopReadAloud, resumeFromPosition]);

  const handleCycleSpeed = useCallback(() => {
    const nextIdx = (safeRateIdx + 1) % raRates.length;
    const nextRate = raRates[nextIdx] ?? raSettings.default_rate;
    setRateIdx(nextIdx);
    rateRef.current = nextRate;
    if (activeEngineRef.current === "audio" && audioRef.current) {
      applyAudioPlaybackRate(audioRef.current, nextRate);
      return;
    }
    if (playbackState === "playing") resumeFromPosition(nextRate);
  }, [safeRateIdx, raRates, raSettings.default_rate, playbackState, resumeFromPosition]);

  const onChunkSetChanged = useEffectEvent((prevKey: string) => {
    if (!raSettings.continue_on_page_turn || playbackState === "idle") return;
    const prevLive = livePositionRef.current;
    if (activeEngineRef.current === "audio" && audioRef.current && prevLive?.key === prevKey) {
      const liveTime = audioRef.current.currentTime;
      savedPositionsRef.current.set(prevKey, { chunkId: prevLive.chunkId, chunkIdx: prevLive.chunkIdx, timeSec: liveTime, charIndex: prevLive.charIndex });
      prevLive.timeSec = liveTime;
    }
    if (chunks.length === 0) {
      cancelSpeechEngine();
      return;
    }
    const res = resolveNextSpreadStart(chunks, prevLive, savedPositionsRef.current.get(chunkKey));
    if (res.source === "carryover" || res.source === "saved") {
      if (playbackState === "playing") {
        recordPosition(chunkKey, res.chunkId, res.chunkIdx, res.timeSec, res.charIndex);
        startAtChunk(res.chunkIdx, res.timeSec, res.charIndex, rateRef.current);
      } else {
        // Invalidate the old paused engine session so Resume starts fresh on the new spread's chunks/tracks.
        cancelSpeechEngine();
        recordPosition(chunkKey, res.chunkId, res.chunkIdx, res.timeSec, res.charIndex);
        positionRef.current = { idx: res.chunkIdx, charIndex: res.charIndex };
        setActiveChunk({ idx: res.chunkIdx, key: chunkKey });
      }
      return;
    }
    if (playbackState === "playing") {
      if (prebakedTracks && detectAudioSupport()) playPrebakedTracks(prebakedTracks, 0, rateRef.current, 0);
      else speakFromIndex(0, 0, rateRef.current);
      return;
    }
    cancelSpeechEngine();
    livePositionRef.current = null;
    positionRef.current = { idx: 0, charIndex: 0 };
    setActiveChunk(null);
  });

  const lastChunkKeyRef = useRef(chunkKey);
  useEffect(() => {
    if (lastChunkKeyRef.current === chunkKey) return;
    const prevKey = lastChunkKeyRef.current;
    lastChunkKeyRef.current = chunkKey;
    onChunkSetChanged(prevKey);
  }, [chunkKey]);

  return {
    speechSupported, audioSupported, readAloudSupported, usingFallbackVoice, playbackState,
    activeChunkId, activeWord, currentRate, speechAnnouncement,
    stopReadAloud, clearAnnouncement, playFromChunk, handlePlayPauseResume, handleCycleSpeed,
  };
}
