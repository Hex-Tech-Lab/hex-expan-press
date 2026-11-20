"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BookPreviewReadAloudSettings } from "../../../../payments/src/settings_registry";
import type { ReadAloudChunk } from "./book-previewer-text";
import type { ReadAloudState } from "./book-preview-accessible-card";

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

/** Manages Web Speech API sentence-chunk playback, speed cycling, highlight tracking, and lifecycle stops. */
export function useReadAloud(
  chunks: ReadAloudChunk[],
  raSettings: BookPreviewReadAloudSettings,
  onExpandPanel: () => void,
) {
  const [playbackState, setPlaybackState] = useState<ReadAloudState>("idle");
  const [activeChunkIdx, setActiveChunkIdx] = useState<number | null>(null);
  const [rateIdx, setRateIdx] = useState(() => {
    const idx = raSettings.rates.indexOf(raSettings.default_rate);
    return idx >= 0 ? idx : 0;
  });
  const [speechAnnouncement, setSpeechAnnouncement] = useState("");
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const speechSessionRef = useRef(0);
  const pausedAtRateRef = useRef<number | null>(null);
  const speechSupported = useSyncExternalStore(subscribeNoop, detectSpeechSynthesisSupport, () => false);

  const raRates = useMemo(
    () => (raSettings.rates.length > 0 ? raSettings.rates : [raSettings.default_rate]),
    [raSettings.rates, raSettings.default_rate],
  );
  const safeRateIdx = Math.min(Math.max(0, rateIdx), raRates.length - 1);
  const currentRate = raRates[safeRateIdx] ?? raSettings.default_rate;
  const activeChunkId = activeChunkIdx !== null ? (chunks[activeChunkIdx]?.id ?? null) : null;

  const cancelSpeechEngine = useCallback(() => {
    speechSessionRef.current += 1;
    utteranceRef.current = null;
    pausedAtRateRef.current = null;
    if (detectSpeechSynthesisSupport()) {
      window.speechSynthesis.cancel?.();
    }
  }, []);

  const stopReadAloud = useCallback(() => {
    cancelSpeechEngine();
    setPlaybackState("idle");
    setActiveChunkIdx(null);
  }, [cancelSpeechEngine]);

  const clearAnnouncement = useCallback(() => {
    setSpeechAnnouncement("");
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stopReadAloud();
    };
    const onPageHide = () => {
      stopReadAloud();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      cancelSpeechEngine();
    };
  }, [stopReadAloud, cancelSpeechEngine]);

  const speakFromIndex = useCallback(
    (startIdx: number, rate: number) => {
      if (!detectSpeechSynthesisSupport() || startIdx < 0 || startIdx >= chunks.length) {
        stopReadAloud();
        return;
      }
      const session = ++speechSessionRef.current;
      window.speechSynthesis.cancel?.();
      // Chrome keeps the paused flag across cancel(); clear it or speak() stays silent.
      if (window.speechSynthesis.paused) window.speechSynthesis.resume?.();
      pausedAtRateRef.current = null;
      setSpeechAnnouncement("");
      setPlaybackState("playing");

      const speakOne = (idx: number) => {
        if (speechSessionRef.current !== session) return;
        if (idx >= chunks.length) {
          utteranceRef.current = null;
          pausedAtRateRef.current = null;
          setPlaybackState("idle");
          setActiveChunkIdx(null);
          setSpeechAnnouncement(raSettings.labels.finished_announcement);
          return;
        }
        const chunk = chunks[idx];
        const UtteranceCtor = window.SpeechSynthesisUtterance;
        const utterance = new UtteranceCtor(chunk.text);
        utterance.rate = rate;
        utteranceRef.current = utterance;
        setActiveChunkIdx(idx);
        utterance.onstart = () => {
          if (speechSessionRef.current !== session) return;
          setActiveChunkIdx(idx);
        };
        utterance.onend = () => {
          if (speechSessionRef.current !== session) return;
          speakOne(idx + 1);
        };
        utterance.onerror = () => {
          if (speechSessionRef.current !== session) return;
          utteranceRef.current = null;
          pausedAtRateRef.current = null;
          setPlaybackState("idle");
          setActiveChunkIdx(null);
        };
        window.speechSynthesis.speak(utterance);
      };

      speakOne(startIdx);
    },
    [chunks, stopReadAloud, raSettings.labels.finished_announcement],
  );

  const handlePlayPauseResume = useCallback(() => {
    if (!raSettings.enabled || !detectSpeechSynthesisSupport() || chunks.length === 0) return;
    if (playbackState === "idle") {
      onExpandPanel();
      speakFromIndex(0, currentRate);
      return;
    }
    if (playbackState === "playing") {
      setPlaybackState("paused");
      pausedAtRateRef.current = currentRate;
      window.speechSynthesis.pause?.();
      return;
    }
    if (window.speechSynthesis.paused && pausedAtRateRef.current === currentRate) {
      setPlaybackState("playing");
      pausedAtRateRef.current = null;
      window.speechSynthesis.resume?.();
      return;
    }
    speakFromIndex(activeChunkIdx ?? 0, currentRate);
  }, [raSettings.enabled, chunks.length, playbackState, onExpandPanel, speakFromIndex, currentRate, activeChunkIdx]);

  const handleCycleSpeed = useCallback(() => {
    const nextIdx = (safeRateIdx + 1) % raRates.length;
    const nextRate = raRates[nextIdx] ?? raSettings.default_rate;
    setRateIdx(nextIdx);
    if (playbackState === "playing") {
      speakFromIndex(activeChunkIdx ?? 0, nextRate);
    }
  }, [safeRateIdx, raRates, raSettings.default_rate, playbackState, speakFromIndex, activeChunkIdx]);

  return {
    speechSupported,
    playbackState,
    activeChunkId,
    currentRate,
    speechAnnouncement,
    stopReadAloud,
    clearAnnouncement,
    handlePlayPauseResume,
    handleCycleSpeed,
  };
}
