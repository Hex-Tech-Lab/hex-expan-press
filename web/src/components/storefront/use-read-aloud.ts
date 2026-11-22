"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BookPreviewReadAloudSettings } from "../../../../payments/src/settings_registry";
import type { ReadAloudChunk } from "./book-previewer-text";
import type { ReadAloudState } from "./book-preview-accessible-card";
import { rankVoice } from "./read-aloud-voice";
import {
  activeWordForTrackTime,
  applyAudioPlaybackRate,
  chunkIndexForTrackTime,
  detectAudioSupport,
  parsePreviewAudioManifest,
  playAudioWithErrorHandler,
  resolveSpreadAudioTracks,
  selectTrackAudioCandidates,
  type PreviewAudioManifest,
  type PreviewAudioPageTrack,
} from "./read-aloud-audio";

/** The word being spoken, as char offsets into its sentence chunk. Only set when highlight_words is on. */
export interface ReadAloudWord {
  chunkId: string;
  start: number;
  end: number;
}

function subscribeNoop(): () => void {
  return () => {};
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
function engineBusy(synth: SpeechSynthesis): boolean {
  return Boolean(synth.speaking || synth.pending || synth.paused);
}

/** End offset of the word that starts at charIndex. */
function wordEndAt(text: string, charIndex: number): number {
  const match = /^\S+/.exec(text.slice(charIndex));
  return charIndex + (match ? match[0].length : 0);
}

/**
 * Sentence-chunk Read Aloud: prefers pre-baked narrated MP3 + timing manifest when available
 * (instant start, $0 runtime cost, pitch-preserved speed changes via HTML5 <audio>), and falls
 * back transparently to browser Web Speech when no audio manifest is present or audio fails.
 */
export function useReadAloud(
  chunks: ReadAloudChunk[],
  raSettings: BookPreviewReadAloudSettings,
  onExpandPanel: () => void,
  audioManifestUrl?: string | null,
  audioBasePath = "/books/audio",
) {
  const [playbackState, setPlaybackState] = useState<ReadAloudState>("idle");
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
  const activeEngineRef = useRef<"none" | "audio" | "speech">("none");
  const audioQueueRef = useRef<{
    tracks: PreviewAudioPageTrack[];
    trackIdx: number;
    candidates: string[];
    candidateIdx: number;
  } | null>(null);

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
  const audioSupported = Boolean(audioElementSupported && prebakedTracks);
  const readAloudSupported = audioSupported || speechSupported;
  const activeChunkId = activeChunkIdx !== null ? (chunks[activeChunkIdx]?.id ?? null) : null;

  const stopAudioEngine = useCallback((clearSrc: boolean) => {
    const audio = audioRef.current;
    audioQueueRef.current = null;
    if (!audio) return;
    audio.onloadedmetadata = null;
    audio.ontimeupdate = null;
    audio.onended = null;
    audio.onerror = null;
    try {
      audio.pause();
      if (clearSrc) {
        audio.removeAttribute("src");
        audio.load?.();
      }
    } catch (err) {
      console.warn("[read-aloud] Audio teardown warning:", err);
    }
  }, []);

  const cancelSpeechEngine = useCallback(() => {
    speechSessionRef.current += 1;
    pausedAtRateRef.current = null;
    positionRef.current = null;
    activeEngineRef.current = "none";
    stopAudioEngine(false);
    if (detectSpeechSynthesisSupport() && engineBusy(window.speechSynthesis)) {
      window.speechSynthesis.cancel?.();
    }
  }, [stopAudioEngine]);

  const stopReadAloud = useCallback(() => {
    cancelSpeechEngine();
    setPlaybackState("idle");
    setActiveChunk(null);
    setActiveWord(null);
  }, [cancelSpeechEngine]);

  const clearAnnouncement = useCallback(() => {
    setSpeechAnnouncement("");
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stopReadAloud();
    };
    const onPageHide = () => stopReadAloud();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      speechSessionRef.current += 1;
      activeEngineRef.current = "none";
      stopAudioEngine(true);
      if (detectSpeechSynthesisSupport() && engineBusy(window.speechSynthesis)) {
        window.speechSynthesis.cancel?.();
      }
    };
  }, [stopReadAloud, stopAudioEngine]);

  useEffect(() => {
    if (!detectSpeechSynthesisSupport()) return;
    const synth = window.speechSynthesis;
    const chooseVoice = () => {
      voiceRef.current = rankVoice(synth.getVoices?.() ?? [], raSettings.voice);
    };
    chooseVoice();
    synth.addEventListener?.("voiceschanged", chooseVoice);
    return () => synth.removeEventListener?.("voiceschanged", chooseVoice);
  }, [raSettings.voice]);

  const speakFromIndex = useCallback(
    (startIdx: number, startCharIndex: number, rate: number) => {
      if (!detectSpeechSynthesisSupport() || startIdx < 0 || startIdx >= chunks.length) {
        stopReadAloud();
        return;
      }
      stopAudioEngine(false);
      const synth = window.speechSynthesis;
      const session = ++speechSessionRef.current;
      activeEngineRef.current = "speech";
      if (engineBusy(synth)) synth.cancel?.();
      if (synth.paused) synth.resume?.();
      pausedAtRateRef.current = null;
      setSpeechAnnouncement("");
      setPlaybackState("playing");
      const voice = voiceRef.current ?? rankVoice(synth.getVoices?.() ?? [], raSettings.voice);
      const stale = () => speechSessionRef.current !== session;

      const speakChunk = (idx: number, fromChar: number) => {
        if (stale()) return;
        if (idx >= chunks.length) {
          pausedAtRateRef.current = null;
          positionRef.current = null;
          activeEngineRef.current = "none";
          setPlaybackState("idle");
          setActiveChunk(null);
          setActiveWord(null);
          setSpeechAnnouncement(raSettings.labels.finished_announcement);
          return;
        }
        const chunk = chunks[idx];
        const UtteranceCtor = window.SpeechSynthesisUtterance;
        const utterance = new UtteranceCtor(chunk.text.slice(fromChar));
        utterance.rate = rate;
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }
        positionRef.current = { idx, charIndex: fromChar };
        setActiveChunk({ idx, key: chunkKey });
        setActiveWord(null);
        utterance.onstart = () => {
          if (!stale()) setActiveChunk({ idx, key: chunkKey });
        };
        utterance.onboundary = (event) => {
          if (stale() || typeof event.charIndex !== "number") return;
          const charIndex = fromChar + event.charIndex;
          positionRef.current = { idx, charIndex };
          if (raSettings.highlight_words) {
            setActiveWord({ chunkId: chunk.id, start: charIndex, end: wordEndAt(chunk.text, charIndex) });
          }
        };
        utterance.onend = () => {
          if (!stale()) speakChunk(idx + 1, 0);
        };
        utterance.onerror = () => {
          if (stale()) return;
          pausedAtRateRef.current = null;
          positionRef.current = null;
          activeEngineRef.current = "none";
          setPlaybackState("idle");
          setActiveChunk(null);
          setActiveWord(null);
        };
        synth.speak(utterance);
      };

      speakChunk(startIdx, startCharIndex);
    },
    [chunks, chunkKey, stopReadAloud, stopAudioEngine, raSettings.labels.finished_announcement, raSettings.voice, raSettings.highlight_words],
  );

  const playPrebakedTracks = useCallback(
    (tracks: PreviewAudioPageTrack[], startTrackIdx: number, rate: number) => {
      if (!detectAudioSupport() || tracks.length === 0) {
        if (detectSpeechSynthesisSupport()) speakFromIndex(0, 0, rate);
        else stopReadAloud();
        return;
      }
      if (detectSpeechSynthesisSupport() && engineBusy(window.speechSynthesis)) {
        window.speechSynthesis.cancel?.();
      }
      const session = ++speechSessionRef.current;
      const audio = audioRef.current ?? new window.Audio();
      audioRef.current = audio;
      pausedAtRateRef.current = null;
      positionRef.current = null;
      setSpeechAnnouncement("");
      setPlaybackState("playing");
      setActiveWord(null);
      const stale = () => speechSessionRef.current !== session;

      const startTrack = (trackIdx: number, candidateIdx = 0) => {
        if (stale()) return;
        const track = tracks[trackIdx];
        if (!track) {
          activeEngineRef.current = "none";
          audioQueueRef.current = null;
          setPlaybackState("idle");
          setActiveChunk(null);
          setActiveWord(null);
          setSpeechAnnouncement(raSettings.labels.finished_announcement);
          return;
        }
        const candidates = selectTrackAudioCandidates(track, audio);
        const sourceUrl = candidates[candidateIdx];
        if (!sourceUrl) {
          const fallbackIdx = chunks.findIndex((chunk) => chunk.pageIndex === track.pageIndex);
          if (detectSpeechSynthesisSupport()) speakFromIndex(fallbackIdx >= 0 ? fallbackIdx : 0, 0, rateRef.current);
          else stopReadAloud();
          return;
        }
        activeEngineRef.current = "audio";
        audioQueueRef.current = { tracks, trackIdx, candidates, candidateIdx };
        const initialIdx = chunkIndexForTrackTime(track, 0, chunks);
        if (initialIdx !== null) setActiveChunk({ idx: initialIdx, key: chunkKey });
        const syncWordForTime = (timeSec: number) => {
          if (!raSettings.highlight_words) {
            setActiveWord(null);
            return;
          }
          const nextWord = activeWordForTrackTime(track, timeSec);
          setActiveWord((prev) =>
            prev?.chunkId === nextWord?.chunkId && prev?.start === nextWord?.start && prev?.end === nextWord?.end
              ? prev
              : nextWord,
          );
        };
        syncWordForTime(0);

        let handledFailure = false;
        const handleSourceFailure = (reason: unknown) => {
          if (stale() || handledFailure) return;
          handledFailure = true;
          if (candidateIdx + 1 < candidates.length) {
            console.warn("[read-aloud] Audio source failed, falling back to secondary codec:", sourceUrl, reason);
            startTrack(trackIdx, candidateIdx + 1);
            return;
          }
          console.warn("[read-aloud] Audio playback error, falling back to Web Speech:", reason);
          const fallbackIdx = chunks.findIndex((chunk) => chunk.pageIndex === track.pageIndex);
          if (detectSpeechSynthesisSupport()) speakFromIndex(fallbackIdx >= 0 ? fallbackIdx : 0, 0, rateRef.current);
          else stopReadAloud();
        };

        audio.onloadedmetadata = () => {
          if (!stale()) applyAudioPlaybackRate(audio, rateRef.current);
        };
        audio.ontimeupdate = () => {
          if (stale()) return;
          const nextIdx = chunkIndexForTrackTime(track, audio.currentTime, chunks);
          if (nextIdx !== null) {
            setActiveChunk((prev) => (prev?.key === chunkKey && prev.idx === nextIdx ? prev : { idx: nextIdx, key: chunkKey }));
          }
          syncWordForTime(audio.currentTime);
        };
        audio.onended = () => {
          if (!stale()) startTrack(trackIdx + 1, 0);
        };
        audio.onerror = () => handleSourceFailure("HTMLAudioElement error event");

        audio.preload = "none";
        applyAudioPlaybackRate(audio, rateRef.current);
        audio.src = sourceUrl;
        applyAudioPlaybackRate(audio, rateRef.current);

        playAudioWithErrorHandler(audio, (err) => handleSourceFailure(err));
      };

      rateRef.current = rate;
      startTrack(startTrackIdx);
    },
    [chunks, chunkKey, raSettings.highlight_words, raSettings.labels.finished_announcement, speakFromIndex, stopReadAloud],
  );

  const startFromTop = useCallback(
    (rate: number) => {
      if (prebakedTracks && detectAudioSupport()) playPrebakedTracks(prebakedTracks, 0, rate);
      else speakFromIndex(0, 0, rate);
    },
    [prebakedTracks, playPrebakedTracks, speakFromIndex],
  );

  const resumeFromPosition = useCallback(
    (rate: number) => {
      const pos = positionRef.current;
      const idx = pos?.idx ?? activeChunkIdx ?? 0;
      const charIndex = pos && pos.idx === idx ? pos.charIndex : 0;
      speakFromIndex(idx, charIndex, rate);
    },
    [activeChunkIdx, speakFromIndex],
  );

  const handlePlayPauseResume = useCallback(() => {
    if (!raSettings.enabled || !readAloudSupported || chunks.length === 0) return;
    if (playbackState === "idle") {
      startFromTop(currentRate);
      onExpandPanel();
      return;
    }
    if (playbackState === "playing") {
      setPlaybackState("paused");
      pausedAtRateRef.current = currentRate;
      if (activeEngineRef.current === "audio" && audioRef.current) audioRef.current.pause();
      else window.speechSynthesis.pause?.();
      return;
    }
    if (activeEngineRef.current === "audio" && audioRef.current && audioQueueRef.current) {
      const audio = audioRef.current;
      const session = speechSessionRef.current;
      const queue = audioQueueRef.current;
      setPlaybackState("playing");
      pausedAtRateRef.current = null;
      rateRef.current = currentRate;
      applyAudioPlaybackRate(audio, currentRate);
      playAudioWithErrorHandler(audio, () => {
        if (speechSessionRef.current !== session) return;
        const track = queue.tracks[queue.trackIdx];
        const fallbackIdx = track ? chunks.findIndex((chunk) => chunk.pageIndex === track.pageIndex) : 0;
        if (detectSpeechSynthesisSupport()) speakFromIndex(fallbackIdx >= 0 ? fallbackIdx : 0, 0, currentRate);
        else stopReadAloud();
      });
      return;
    }
    if (activeEngineRef.current === "none") {
      startFromTop(currentRate);
      return;
    }
    if (window.speechSynthesis.paused && pausedAtRateRef.current === currentRate) {
      setPlaybackState("playing");
      pausedAtRateRef.current = null;
      window.speechSynthesis.resume?.();
      return;
    }
    resumeFromPosition(currentRate);
  }, [raSettings.enabled, readAloudSupported, chunks, playbackState, startFromTop, currentRate, onExpandPanel, speakFromIndex, stopReadAloud, resumeFromPosition]);

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

  const onChunkSetChanged = useEffectEvent(() => {
    if (!raSettings.continue_on_page_turn || playbackState === "idle") return;
    if (chunks.length === 0) {
      cancelSpeechEngine();
      return;
    }
    if (playbackState === "playing") {
      startFromTop(rateRef.current);
      return;
    }
    cancelSpeechEngine();
    positionRef.current = { idx: 0, charIndex: 0 };
  });
  const lastChunkKeyRef = useRef(chunkKey);
  useEffect(() => {
    if (lastChunkKeyRef.current === chunkKey) return;
    lastChunkKeyRef.current = chunkKey;
    onChunkSetChanged();
  }, [chunkKey]);

  return {
    speechSupported,
    audioSupported,
    readAloudSupported,
    playbackState,
    activeChunkId,
    activeWord,
    currentRate,
    speechAnnouncement,
    stopReadAloud,
    clearAnnouncement,
    handlePlayPauseResume,
    handleCycleSpeed,
  };
}
