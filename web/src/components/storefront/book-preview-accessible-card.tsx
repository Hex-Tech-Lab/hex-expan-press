"use client";

import { Fragment, type ReactNode } from "react";
import type {
  BookPreviewReadAloudSettings,
  BookPreviewTextStructureSettings,
} from "../../../../payments/src/settings_registry";
import type { AccessiblePageGroup, ReadAloudChunk } from "./book-previewer-text";
import type { ReadAloudWord } from "./use-read-aloud";

export type ReadAloudState = "idle" | "playing" | "paused";

export const ZoomInIcon = () => (
  <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.35-4.35M11 8v6M8 11h6" />
  </svg>
);

export const ZoomOutIcon = () => (
  <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.35-4.35M8 11h6" />
  </svg>
);

export const ResetZoomIcon = () => (
  <svg aria-hidden="true" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    aria-hidden="true"
    className={`w-4 h-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const SpeakerIcon = () => (
  <svg aria-hidden="true" className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
  </svg>
);

const PauseIcon = () => (
  <svg aria-hidden="true" className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </svg>
);

const StopIcon = () => (
  <svg aria-hidden="true" className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
);

export interface BookPreviewAccessibleCardProps {
  panelId: string;
  textOpen: boolean;
  spreadCount: number;
  pages: AccessiblePageGroup[];
  activeChunkId: string | null;
  activeWord: ReadAloudWord | null;
  playbackState: ReadAloudState;
  currentRate: number;
  showReadAloudControls: boolean;
  usingFallbackVoice?: boolean;
  speechAnnouncement: string;
  readAloudSettings: BookPreviewReadAloudSettings;
  textStructureSettings: BookPreviewTextStructureSettings;
  onTogglePanel: () => void;
  onPlayPauseResume: () => void;
  onStop: () => void;
  onCycleSpeed: () => void;
}

/** WAI-ARIA APG disclosure panel rendering structured page blocks with optional Web Speech Read Aloud controls. */
export function BookPreviewAccessibleCard({
  panelId,
  textOpen,
  spreadCount,
  pages,
  activeChunkId,
  activeWord,
  playbackState,
  currentRate,
  showReadAloudControls,
  usingFallbackVoice = false,
  speechAnnouncement,
  readAloudSettings,
  textStructureSettings,
  onTogglePanel,
  onPlayPauseResume,
  onStop,
  onCycleSpeed,
}: BookPreviewAccessibleCardProps) {
  const raLabels = readAloudSettings.labels;
  const readAloudActionLabel =
    playbackState === "playing"
      ? raLabels.pause
      : playbackState === "paused"
        ? raLabels.resume
        : raLabels.play;
  const readAloudActionText =
    playbackState === "playing"
      ? raLabels.pause_text
      : playbackState === "paused"
        ? raLabels.resume_text
        : raLabels.play_text;

  const renderChunks = (chunks: ReadAloudChunk[]): ReactNode =>
    chunks.map((chunk, idx) => {
      const isActive = activeChunkId === chunk.id;
      const word = isActive && activeWord?.chunkId === chunk.id ? activeWord : null;
      return (
        <Fragment key={chunk.id}>
          {idx > 0 ? " " : null}
          <span
            data-testid="read-aloud-sentence"
            data-chunk-id={chunk.id}
            data-active={isActive ? "true" : "false"}
            className={
              isActive
                ? "bg-[#fff2e4] text-gray-950 rounded px-1 ring-1 ring-[#FF9E80] transition-colors duration-200 motion-reduce:transition-none"
                : "transition-colors duration-200 motion-reduce:transition-none"
            }
          >
            {word ? (
              <>
                {chunk.text.slice(0, word.start)}
                <mark
                  data-testid="read-aloud-word"
                  className="bg-[#FF9E80]/40 text-gray-950 rounded-sm"
                >
                  {chunk.text.slice(word.start, word.end)}
                </mark>
                {chunk.text.slice(word.end)}
              </>
            ) : (
              chunk.text
            )}
          </span>
        </Fragment>
      );
    });

  return (
    <div
      data-testid="book-preview-accessible-card"
      className="text-xs text-gray-700 rounded-2xl border border-[#e8dacb] bg-white/70 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={textOpen}
          aria-controls={panelId}
          onClick={onTogglePanel}
          data-testid="book-preview-accessible-toggle"
          className="inline-flex items-center gap-2 min-h-[44px] text-left font-semibold text-gray-800 hover:text-gray-950 select-none cursor-pointer"
        >
          <ChevronIcon open={textOpen} />
          <span>
            {spreadCount > 1
              ? textStructureSettings.toggle_plural
              : textStructureSettings.toggle_single}
          </span>
        </button>

        {showReadAloudControls && (
          <div
            role="group"
            aria-label={raLabels.group_aria_label}
            data-testid="read-aloud-controls"
            className="flex flex-nowrap items-center gap-1.5"
          >
            <button
              type="button"
              onClick={onPlayPauseResume}
              aria-label={readAloudActionLabel}
              title={readAloudActionLabel}
              data-testid="read-aloud-toggle"
              data-playback-state={playbackState}
              className={`inline-flex items-center justify-center gap-1.5 h-11 w-11 px-0 py-0 sm:h-auto sm:w-auto sm:min-h-[44px] sm:min-w-[44px] sm:px-3.5 sm:py-2 touch-manipulation rounded-full text-xs font-semibold transition-colors cursor-pointer ${
                playbackState === "playing"
                  ? "bg-charcoal text-white hover:bg-[#2a2a2a]"
                  : "border border-[#dcc7b4] bg-white text-gray-900 hover:bg-[#faf5ee]"
              }`}
            >
              {playbackState === "playing" ? <PauseIcon /> : <SpeakerIcon />}
              <span className="hidden sm:inline">{readAloudActionText}</span>
            </button>

            {playbackState !== "idle" && (
              <button
                type="button"
                onClick={onStop}
                aria-label={raLabels.stop}
                title={raLabels.stop}
                data-testid="read-aloud-stop"
                className="inline-flex items-center justify-center gap-1.5 h-11 w-11 px-0 py-0 sm:h-auto sm:w-auto sm:min-h-[44px] sm:min-w-[44px] sm:px-3 sm:py-2 touch-manipulation rounded-full border border-[#dcc7b4] bg-white text-xs font-semibold text-gray-900 hover:bg-[#faf5ee] transition-colors cursor-pointer"
              >
                <StopIcon />
                <span className="hidden sm:inline">{raLabels.stop_text}</span>
              </button>
            )}

            <button
              type="button"
              onClick={onCycleSpeed}
              aria-label={`${raLabels.speed_aria_label} (${currentRate}${raLabels.rate_suffix})`}
              title={raLabels.speed_aria_label}
              data-testid="read-aloud-speed"
              data-rate={String(currentRate)}
              className="inline-flex items-center justify-center h-11 w-11 px-0 py-0 sm:h-auto sm:w-auto sm:min-h-[44px] sm:min-w-[48px] sm:px-3 sm:py-2 touch-manipulation rounded-full border border-[#dcc7b4] bg-white font-mono text-[11px] leading-none sm:text-xs sm:leading-normal font-semibold whitespace-nowrap text-gray-900 hover:bg-[#faf5ee] transition-colors cursor-pointer"
            >
              {`${currentRate}${raLabels.rate_suffix}`}
            </button>
          </div>
        )}
      </div>

      <span className="sr-only" aria-live="polite" data-testid="read-aloud-status">
        {speechAnnouncement}
      </span>

      {usingFallbackVoice && (
        <p
          role="status"
          data-testid="read-aloud-fallback-advisory"
          className="mt-2.5 rounded-xl border border-[#e8dacb] bg-[#faf5ee] px-3 py-2 text-[11px] leading-relaxed text-gray-700"
        >
          {raLabels.fallback_advisory_text}{" "}
          <a
            href={raLabels.fallback_advisory_link_url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="read-aloud-fallback-upgrade-link"
            className="font-semibold text-gray-900 underline underline-offset-2 hover:text-gray-700"
          >
            {raLabels.fallback_advisory_link_label}
          </a>
        </p>
      )}

      <div
        id={panelId}
        hidden={!textOpen}
        data-testid="book-preview-accessible-text"
        className={textOpen ? "mt-3 space-y-3 leading-relaxed text-gray-700" : "hidden"}
      >
        {pages.map((page) => {
          const renderedNodes: ReactNode[] = [];
          let listItems: typeof page.blocks = [];
          const flushList = (keyPrefix: string) => {
            if (listItems.length === 0) return;
            renderedNodes.push(
              <ul key={keyPrefix} className="list-disc pl-5 space-y-1 text-xs leading-relaxed text-gray-700">
                {listItems.map((item) => (
                  <li key={item.blockIndex}>{renderChunks(item.chunks)}</li>
                ))}
              </ul>,
            );
            listItems = [];
          };

          for (const item of page.blocks) {
            if (item.block.kind === "list-item") {
              listItems.push(item);
              continue;
            }
            flushList(`ul-${page.pageIndex}-${item.blockIndex}`);
            if (item.block.kind === "heading") {
              if (item.block.level === 3) {
                renderedNodes.push(
                  <h3 key={item.blockIndex} className="text-sm font-semibold text-gray-900">
                    {renderChunks(item.chunks)}
                  </h3>,
                );
              } else {
                renderedNodes.push(
                  <h4 key={item.blockIndex} className="text-xs font-semibold uppercase tracking-wide text-gray-800">
                    {renderChunks(item.chunks)}
                  </h4>,
                );
              }
            } else {
              renderedNodes.push(
                <p key={item.blockIndex} className="text-xs leading-relaxed text-gray-700">
                  {renderChunks(item.chunks)}
                </p>,
              );
            }
          }
          flushList(`ul-${page.pageIndex}-end`);

          return (
            <div
              key={page.pageIndex}
              data-testid={`accessible-page-${page.pageIndex + 1}`}
              className="space-y-2 pt-2 first:pt-0 border-t border-[#e8dacb]/60 first:border-t-0"
            >
              <p className="font-mono text-[11px] font-medium uppercase tracking-wider text-gray-500">
                {`${textStructureSettings.page_label_prefix} ${page.pageIndex + 1}`}
              </p>
              {renderedNodes}
            </div>
          );
        })}
      </div>
    </div>
  );
}
