"use client";

import type { FormEvent } from "react";
import type { BookPreviewToolbarLabels } from "../../../../payments/src/settings_registry";
import { ArrowIcon } from "../brand/brand";
import { ResetZoomIcon, ZoomInIcon, ZoomOutIcon } from "./book-preview-accessible-card";
import type { PreviewZoomAction } from "./book-previewer-text";

export interface BookPreviewToolbarProps {
  bookTitle: string;
  labels: BookPreviewToolbarLabels;
  goToInputId: string;
  pageInput: string;
  totalPages: number;
  status: "loading" | "ready" | "error";
  zoom: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  canResetZoom: boolean;
  canFlipPrev: boolean;
  canFlipNext: boolean;
  onApplyZoom: (action: PreviewZoomAction) => void;
  onPageInputChange: (val: string) => void;
  onPageInputReset: () => void;
  onGoToPageSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFlipPrev: () => void;
  onFlipNext: () => void;
}

/** Zoom, go-to-page, and Prev/Next navigation toolbar for the BookPreviewer header. */
export function BookPreviewToolbar({
  bookTitle,
  labels,
  goToInputId,
  pageInput,
  totalPages,
  status,
  zoom,
  canZoomIn,
  canZoomOut,
  canResetZoom,
  canFlipPrev,
  canFlipNext,
  onApplyZoom,
  onPageInputChange,
  onPageInputReset,
  onGoToPageSubmit,
  onFlipPrev,
  onFlipNext,
}: BookPreviewToolbarProps) {
  return (
    <div className="flex w-full flex-nowrap items-center justify-between gap-1 sm:w-auto sm:flex-wrap sm:justify-start sm:gap-2 self-start lg:self-auto">
      <div
        role="toolbar"
        aria-label={labels.toolbar_aria_label}
        data-testid="book-preview-toolbar"
        className="flex flex-nowrap items-center gap-1 sm:flex-wrap sm:gap-1.5"
      >
        <button
          type="button"
          onClick={() => onApplyZoom("zoom_out")}
          disabled={!canZoomOut}
          aria-label={labels.zoom_out}
          title={labels.zoom_out}
          data-testid="book-preview-zoom-out"
          className="hidden sm:inline-flex items-center justify-center min-h-[44px] min-w-[44px] touch-manipulation rounded-full border border-[#dcc7b4] bg-white text-gray-900 hover:bg-[#faf5ee] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
        >
          <ZoomOutIcon />
        </button>
        <span
          data-testid="book-preview-zoom-label"
          aria-live="polite"
          className="sr-only sm:not-sr-only sm:min-w-[3rem] text-center font-mono text-xs font-medium text-gray-700 select-none"
        >
          {`${Math.round(zoom * 100)}%`}
        </span>
        <button
          type="button"
          onClick={() => onApplyZoom("zoom_in")}
          disabled={!canZoomIn}
          aria-label={labels.zoom_in}
          title={labels.zoom_in}
          data-testid="book-preview-zoom-in"
          className="hidden sm:inline-flex items-center justify-center min-h-[44px] min-w-[44px] touch-manipulation rounded-full border border-[#dcc7b4] bg-white text-gray-900 hover:bg-[#faf5ee] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
        >
          <ZoomInIcon />
        </button>
        <button
          type="button"
          onClick={() => onApplyZoom("reset")}
          disabled={!canResetZoom}
          aria-label={labels.reset_zoom}
          title={labels.reset_zoom}
          data-testid="book-preview-zoom-reset"
          className="hidden sm:inline-flex items-center justify-center min-h-[44px] min-w-[44px] touch-manipulation rounded-full border border-[#dcc7b4] bg-white text-gray-900 hover:bg-[#faf5ee] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
        >
          <ResetZoomIcon />
        </button>
        <form
          onSubmit={onGoToPageSubmit}
          className="inline-flex items-center gap-0.5 sm:gap-1 rounded-full border border-[#dcc7b4] bg-white pl-2 pr-0.5 sm:pl-3 sm:pr-0 min-h-[44px]"
        >
          <label htmlFor={goToInputId} className="sr-only">
            {labels.go_to_page}
          </label>
          <input
            id={goToInputId}
            type="number"
            min={1}
            max={Math.max(1, totalPages)}
            inputMode="numeric"
            value={pageInput}
            onChange={(event) => onPageInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onPageInputReset();
            }}
            disabled={status !== "ready" || totalPages <= 0}
            title={labels.go_to_page}
            data-testid="book-preview-goto-input"
            className="w-7 sm:w-11 bg-transparent text-center font-mono text-sm sm:text-xs tabular-nums font-medium text-gray-900 focus:outline-none disabled:opacity-45"
          />
          <span className="whitespace-nowrap font-mono text-xs tabular-nums text-gray-500 select-none pr-1" aria-hidden="true">
            {`/ ${totalPages || "—"}`}
          </span>
          <button
            type="submit"
            disabled={status !== "ready" || totalPages <= 0}
            aria-label={labels.go_to_page_submit}
            title={labels.go_to_page_submit}
            data-testid="book-preview-goto-submit"
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] touch-manipulation px-0 sm:px-3 rounded-full bg-charcoal hover:bg-[#2a2a2a] text-xs font-semibold text-white disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowIcon className="w-3.5 h-3.5 sm:hidden" />
            <span className="hidden sm:inline">{labels.go_to_page_submit}</span>
          </button>
        </form>
      </div>

      <div className="flex items-center gap-1 sm:gap-2" role="group" aria-label={labels.navigation_aria_label.replace("{title}", bookTitle)}>
        <button
          type="button"
          onClick={onFlipPrev}
          disabled={!canFlipPrev}
          aria-label={labels.prev_page}
          title={labels.prev_page}
          className="inline-flex items-center justify-center gap-2 min-h-[44px] min-w-[44px] touch-manipulation px-0 sm:px-4 py-2.5 rounded-full border border-[#dcc7b4] bg-white text-sm font-semibold text-gray-900 hover:bg-[#faf5ee] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowIcon className="w-3.5 h-3.5 rotate-180" />
          <span className="hidden sm:inline">Prev</span>
        </button>
        <button
          type="button"
          onClick={onFlipNext}
          disabled={!canFlipNext}
          aria-label={labels.next_page}
          title={labels.next_page}
          className="inline-flex items-center justify-center gap-2 min-h-[44px] min-w-[44px] touch-manipulation px-0 sm:px-4 py-2.5 rounded-full bg-charcoal hover:bg-[#2a2a2a] text-sm font-semibold text-white disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
        >
          <span className="hidden sm:inline">Next</span>
          <ArrowIcon />
        </button>
      </div>
    </div>
  );
}
