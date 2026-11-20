"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BookPreviewReadAloudSettings } from "../../../../payments/src/settings_registry";
import type { ReadAloudChunk } from "./book-previewer-text";
import type { ReadAloudState } from "./book-preview-accessible-card";
import { rankVoice } from "./read-aloud-voice";

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

/**
 * True while the engine has speech queued, in flight, or paused. cancel() is issued only then.
 * Firefox can drop a speak() that follows a cancel() of an idle engine, which is one cause of the
 * "first click does nothing" report. Chrome keeps the paused flag across cancel(), so paused counts.
 */
function engineBusy(synth: SpeechSynthesis): boolean {
  return Boolean(synth.speaking || synth.pending || synth.paused);
}

/** End offset of the word that starts at charIndex. Measured from the text, since boundary events do not always carry charLength. */
function wordEndAt(text: string, charIndex: number): number {
  const match = /^\S+/.exec(text.slice(charIndex));
  return charIndex + (match ? match[0].length : 0);
}

/**
 * Sentence-chunk Read Aloud over Web Speech.
 *
 * Speed changes: Web Speech cannot change rate mid-utterance, so a speed change cancels the
 * utterance and speaks the rest of the sentence from the last word boundary (onboundary charIndex).
 * A voice that sends no boundary events restarts the current sentence instead (documented fallback).
 *
 * Highlight: the sentence is highlighted on utterance start (onstart) and advances on end (onend).
 * The word is highlighted from boundary events only when highlight_words is on.
 */
export function useReadAloud(
  chunks: ReadAloudChunk[],
  raSettings: BookPreviewReadAloudSettings,
  onExpandPanel: () => void,
) {
  const [playbackState, setPlaybackState] = useState<ReadAloudState>("idle");
  // The active sentence is stored with the chunk set it belongs to, so a page turn clears it without a state write.
  const [activeChunk, setActiveChunk] = useState<{ idx: number; key: string } | null>(null);
  const chunkKey = useMemo(() => chunks.map((chunk) => chunk.id).join("|"), [chunks]);
  const activeChunkIdx = activeChunk && activeChunk.key === chunkKey ? activeChunk.idx : null;
  const [activeWord, setActiveWord] = useState<ReadAloudWord | null>(null);
  const [rateIdx, setRateIdx] = useState(() => {
    const idx = raSettings.rates.indexOf(raSettings.default_rate);
    return idx >= 0 ? idx : 0;
  });
  const [speechAnnouncement, setSpeechAnnouncement] = useState("");
  const speechSessionRef = useRef(0);
  const pausedAtRateRef = useRef<number | null>(null);
  /** Playback position: the chunk being spoken and the char offset of the last word boundary reached in it. */
  const positionRef = useRef<{ idx: number; charIndex: number } | null>(null);
  /** Voice chosen by rankVoice. Null until voices load; speech then uses the browser default. */
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
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
    pausedAtRateRef.current = null;
    positionRef.current = null;
    if (detectSpeechSynthesisSupport() && engineBusy(window.speechSynthesis)) {
      window.speechSynthesis.cancel?.();
    }
  }, []);

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

  // getVoices() is empty until the engine loads its list. Chrome and Edge fire voiceschanged when it arrives.
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

  /**
   * Speaks chunk startIdx from char offset startCharIndex, then every later chunk.
   * Synchronous from start to speak(): it is called inside click handlers, where the user gesture is still valid.
   */
  const speakFromIndex = useCallback(
    (startIdx: number, startCharIndex: number, rate: number) => {
      if (!detectSpeechSynthesisSupport() || startIdx < 0 || startIdx >= chunks.length) {
        stopReadAloud();
        return;
      }
      const synth = window.speechSynthesis;
      const session = ++speechSessionRef.current;
      if (engineBusy(synth)) synth.cancel?.();
      // Chrome keeps the paused flag across cancel(); clear it or speak() stays silent.
      if (synth.paused) synth.resume?.();
      pausedAtRateRef.current = null;
      setSpeechAnnouncement("");
      setPlaybackState("playing");
      // Voices not loaded yet: speak with the browser default instead of waiting for voiceschanged.
      const voice = voiceRef.current ?? rankVoice(synth.getVoices?.() ?? [], raSettings.voice);
      const stale = () => speechSessionRef.current !== session;

      const speakChunk = (idx: number, fromChar: number) => {
        if (stale()) return;
        if (idx >= chunks.length) {
          pausedAtRateRef.current = null;
          positionRef.current = null;
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
          if (stale()) return;
          setActiveChunk({ idx, key: chunkKey });
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
          if (stale()) return;
          speakChunk(idx + 1, 0);
        };
        utterance.onerror = () => {
          if (stale()) return;
          pausedAtRateRef.current = null;
          positionRef.current = null;
          setPlaybackState("idle");
          setActiveChunk(null);
          setActiveWord(null);
        };
        synth.speak(utterance);
      };

      speakChunk(startIdx, startCharIndex);
    },
    [chunks, chunkKey, stopReadAloud, raSettings.labels.finished_announcement, raSettings.voice, raSettings.highlight_words],
  );

  /** Continues from the last word reached, at the given rate. A chunk with no boundary events restarts from its start. */
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
    if (!raSettings.enabled || !detectSpeechSynthesisSupport() || chunks.length === 0) return;
    if (playbackState === "idle") {
      speakFromIndex(0, 0, currentRate);
      onExpandPanel();
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
    resumeFromPosition(currentRate);
  }, [raSettings.enabled, chunks.length, playbackState, onExpandPanel, speakFromIndex, resumeFromPosition, currentRate]);

  const handleCycleSpeed = useCallback(() => {
    const nextIdx = (safeRateIdx + 1) % raRates.length;
    const nextRate = raRates[nextIdx] ?? raSettings.default_rate;
    setRateIdx(nextIdx);
    if (playbackState === "playing") resumeFromPosition(nextRate);
  }, [safeRateIdx, raRates, raSettings.default_rate, playbackState, resumeFromPosition]);

  // A new chunk set means the flipbook turned to another page or spread. With continue_on_page_turn on,
  // playback continues from the top of the new page at the current rate and voice. A paused session stays
  // paused, and its resume point moves to the top of the new page. With the flag off, the previewer stops playback on the turn.
  // useEffectEvent: reads the latest state without re-running the effect, and may update state.
  const onChunkSetChanged = useEffectEvent(() => {
    if (!raSettings.continue_on_page_turn || playbackState === "idle") return;
    if (chunks.length === 0) {
      // A page with no text: the controls are hidden, so only the engine needs cancelling here.
      cancelSpeechEngine();
      return;
    }
    if (playbackState === "playing") {
      speakFromIndex(0, 0, currentRate);
      return;
    }
    // Paused: drop the paused utterance so resume speaks the new page instead of the old text.
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
