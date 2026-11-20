"use client";

import { useEffect, useId, useRef, useState } from "react";
import type {
  BookPreviewReadAloudVoiceGuideSettings,
  BookPreviewReadAloudVoiceSettings,
} from "../../../../payments/src/settings_registry";
import { stepsForPlatform } from "./basic-voice-guide";
import { useBasicVoiceGuide } from "./use-basic-voice-guide";

interface BasicVoiceGuideCardProps {
  guide: BookPreviewReadAloudVoiceGuideSettings;
  voiceSettings: BookPreviewReadAloudVoiceSettings;
  onRefreshVoice: () => void;
  /** Called after Not now, or after a retry that found a natural voice, so focus can move to the read-aloud controls. */
  onHidden: () => void;
}

const BUTTON_CLASS =
  "min-h-12 rounded-lg px-5 py-2 text-lg font-semibold transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700";

/**
 * Basic-voice guidance on iPhone and iPad. A region labelled by the message, with three buttons.
 * Focus: "Show me how" moves focus to the steps list; leaving the card (Not now, or a retry that found
 * a natural voice) calls onHidden so focus lands on the read-aloud controls, not on the page top.
 */
export function BasicVoiceGuideCard({ guide, voiceSettings, onRefreshVoice, onHidden }: BasicVoiceGuideCardProps) {
  const { visible, platform, retried, retry, dismiss } = useBasicVoiceGuide({ guide, voiceSettings, onRefreshVoice });
  const [stepsOpen, setStepsOpen] = useState(false);
  const stepsListRef = useRef<HTMLOListElement>(null);
  const actedRef = useRef(false);
  const messageId = useId();
  const stepsId = useId();

  useEffect(() => {
    if (stepsOpen) stepsListRef.current?.focus();
  }, [stepsOpen]);

  // The card unmounts after Not now or a successful retry. Hand focus to the read-aloud controls first.
  useEffect(() => {
    if (!visible && actedRef.current) onHidden();
  }, [visible, onHidden]);

  if (!visible) return null;

  const handleDismiss = () => {
    actedRef.current = true;
    dismiss();
  };
  const handleRetry = () => {
    actedRef.current = true;
    retry();
  };

  return (
    <section
      role="region"
      aria-labelledby={messageId}
      data-testid="basic-voice-guide"
      className="mb-4 rounded-xl border-2 border-amber-600 bg-amber-50 p-5 text-gray-950"
    >
      <p id={messageId} className="text-xl leading-relaxed font-medium">
        {guide.message}
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          aria-expanded={stepsOpen}
          aria-controls={stepsId}
          onClick={() => setStepsOpen((open) => !open)}
          className={`${BUTTON_CLASS} bg-gray-950 text-white`}
          data-testid="basic-voice-guide-show-steps"
        >
          {stepsOpen ? guide.hide_steps_label : guide.show_steps_label}
        </button>
        <button
          type="button"
          onClick={handleRetry}
          className={`${BUTTON_CLASS} border-2 border-gray-950 bg-white text-gray-950`}
          data-testid="basic-voice-guide-retry"
        >
          {guide.retry_label}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className={`${BUTTON_CLASS} text-gray-950 underline`}
          data-testid="basic-voice-guide-dismiss"
        >
          {guide.dismiss_label}
        </button>
      </div>

      {retried && (
        <p role="status" className="mt-4 text-lg">
          {guide.retry_still_basic_message}
        </p>
      )}

      {stepsOpen && (
        <ol
          id={stepsId}
          ref={stepsListRef}
          tabIndex={-1}
          aria-label={guide.show_steps_label}
          className="mt-5 list-decimal space-y-4 pl-7 text-xl leading-relaxed marker:font-bold focus:outline-none"
          data-testid="basic-voice-guide-steps"
        >
          {stepsForPlatform(guide, platform ?? "ios").map((step, index) => (
            <li key={index} className="pl-2">
              {step}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
