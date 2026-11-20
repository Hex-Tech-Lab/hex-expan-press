"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type {
  BookPreviewReadAloudVoiceGuideSettings,
  BookPreviewReadAloudVoiceSettings,
} from "../../../../payments/src/settings_registry";
import { detectSpeechSynthesisSupport } from "./use-read-aloud";
import {
  detectVoiceGuidePlatform,
  shouldShowBasicVoiceGuide,
  toVoiceCandidates,
  type DeviceSignals,
  type VoiceGuidePlatform,
} from "./basic-voice-guide";
import type { VoiceCandidate } from "./read-aloud-voice";

function subscribeNoop(): () => void {
  return () => {};
}

function readDevice(): DeviceSignals {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  };
}

/** "Not now" is kept in sessionStorage, so it lasts for this visit only. Storage can be blocked; then the card shows again. */
function readDismissed(key: string, dismissedValue: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === dismissedValue;
  } catch {
    return false;
  }
}

function writeDismissed(key: string, dismissedValue: string): void {
  try {
    window.sessionStorage.setItem(key, dismissedValue);
  } catch {
    // Storage blocked: the card hides for this render only.
  }
}

interface UseBasicVoiceGuideParams {
  guide: BookPreviewReadAloudVoiceGuideSettings;
  voiceSettings: BookPreviewReadAloudVoiceSettings;
  /** Re-runs the playback voice ranking (useReadAloud.refreshVoice), so a retry takes effect at once. */
  onRefreshVoice: () => void;
}

/** Decides whether the basic-voice card shows and which steps it uses, and exposes Try again and Not now. */
export function useBasicVoiceGuide({ guide, voiceSettings, onRefreshVoice }: UseBasicVoiceGuideParams) {
  const speechSupported = useSyncExternalStore(subscribeNoop, detectSpeechSynthesisSupport, () => false);
  const storedDismissed = useSyncExternalStore(
    subscribeNoop,
    () => readDismissed(guide.storage_key, guide.dismissed_value),
    () => false,
  );
  // Null on the server and until the client snapshot is read, so the server render shows no card.
  const platform = useSyncExternalStore(
    subscribeNoop,
    (): VoiceGuidePlatform | null => detectVoiceGuidePlatform(readDevice(), guide),
    (): VoiceGuidePlatform | null => null,
  );
  const [dismissedNow, setDismissedNow] = useState(false);
  const [voices, setVoices] = useState<VoiceCandidate[]>([]);
  const [retried, setRetried] = useState(false);

  // getVoices() is empty until the engine loads its list; voiceschanged fires when it arrives.
  useEffect(() => {
    if (!speechSupported) return;
    const synth = window.speechSynthesis;
    const load = () => setVoices(toVoiceCandidates(synth.getVoices?.() ?? []));
    load();
    synth.addEventListener?.("voiceschanged", load);
    return () => synth.removeEventListener?.("voiceschanged", load);
  }, [speechSupported]);

  const visible = shouldShowBasicVoiceGuide({
    guide,
    voiceSettings,
    platform,
    voices,
    speechSupported,
    dismissed: storedDismissed || dismissedNow,
  });

  const retry = useCallback(() => {
    onRefreshVoice();
    if (detectSpeechSynthesisSupport()) setVoices(toVoiceCandidates(window.speechSynthesis.getVoices?.() ?? []));
    setRetried(true);
  }, [onRefreshVoice]);

  const dismiss = useCallback(() => {
    writeDismissed(guide.storage_key, guide.dismissed_value);
    setDismissedNow(true);
  }, [guide.storage_key, guide.dismissed_value]);

  return { visible, platform, retried, retry, dismiss };
}
