"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Orientation, PageFlip } from "page-flip";
import type { BookPreviewSettings } from "../../../../payments/src/settings_registry";
import { BookPreviewAccessibleCard, type ReadAloudState } from "./book-preview-accessible-card";
import { BookPreviewToolbar } from "./book-preview-toolbar";
import {
  buildSpreadAccessibleModel,
  buildSpreadGroups,
  extractStructuredPageBlocks,
  formatSpreadLabel,
  parseTargetPageInput,
  rasterizePreview,
  resolveZoomIndex,
  setRenderPaused,
  splitIntoSentenceChunks,
  spreadIndexForPage,
  type AccessibleBlock,
  type PdfTextItemLike,
  type PreviewZoomAction,
  type ReadAloudChunk,
} from "./book-previewer-text";
import { useReadAloud } from "./use-read-aloud";

export {
  buildSpreadAccessibleModel,
  buildSpreadGroups,
  extractStructuredPageBlocks,
  formatSpreadLabel,
  parseTargetPageInput,
  resolveZoomIndex,
  splitIntoSentenceChunks,
  spreadIndexForPage,
  type AccessibleBlock,
  type PdfTextItemLike,
  type PreviewZoomAction,
  type ReadAloudChunk,
  type ReadAloudState,
};

export interface BookPreviewerProps {
  id?: string;
  previewPdfUrl: string;
  coverImageUrl?: string | null;
  bookTitle: string;
  settings: BookPreviewSettings;
}

export default function BookPreviewer({
  id,
  previewPdfUrl,
  coverImageUrl = null,
  bookTitle,
  settings,
}: BookPreviewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const flipRef = useRef<PageFlip | null>(null);
  const goToInputId = useId();
  const accessiblePanelId = useId();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [draftPageInput, setDraftPageInput] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const [pageBlocks, setPageBlocks] = useState<AccessibleBlock[][]>([]);
  const [textOpen, setTextOpen] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(0);
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const sectionRef = useRef<HTMLElement>(null);
  // Mount on first view; without IntersectionObserver (old browsers, jsdom) mount at once.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  const visibleRef = useRef(true);

  const zoomLevels = useMemo(
    () => (settings.zoom_levels.length > 0 ? settings.zoom_levels : [1]),
    [settings.zoom_levels],
  );
  const safeZoomIndex = Math.min(Math.max(0, zoomIndex), zoomLevels.length - 1);
  const zoom = zoomLevels[safeZoomIndex] ?? 1;
  const pageInput = draftPageInput ?? String(pageIndex + 1);

  const spreads = useMemo(
    () => buildSpreadGroups(totalPages, orientation, settings.show_cover),
    [totalPages, orientation, settings.show_cover],
  );
  const spreadIdx = spreadIndexForPage(spreads, pageIndex);
  const currentSpread = useMemo(() => spreads[spreadIdx] ?? [], [spreads, spreadIdx]);
  const spreadAccessible = useMemo(
    () => buildSpreadAccessibleModel(currentSpread, pageBlocks, settings.read_aloud.max_chunk_chars),
    [currentSpread, pageBlocks, settings.read_aloud.max_chunk_chars],
  );

  const expandTextPanel = useCallback(() => setTextOpen(true), []);
  const {
    speechSupported,
    playbackState,
    activeChunkId,
    currentRate,
    speechAnnouncement,
    stopReadAloud,
    clearAnnouncement,
    handlePlayPauseResume,
    handleCycleSpeed,
  } = useReadAloud(spreadAccessible.chunks, settings.read_aloud, expandTextPanel);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        visibleRef.current = visible;
        if (visible) setSeen(true);
        setRenderPaused(flipRef.current, !visible);
      },
      { rootMargin: `${settings.visibility_margin_px}px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [settings.visibility_margin_px]);

  useEffect(() => {
    if (status !== "ready" || !hostRef.current) return;
    const node = hostRef.current;
    const measure = () => {
      if (safeZoomIndex !== 0) return;
      const w = node.offsetWidth;
      const h = node.offsetHeight;
      if (w > 0 && h > 0) setStageSize({ w, h });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [status, safeZoomIndex, orientation]);

  // page-flip sizes its canvas bitmap once, from the container's CSS box, and re-syncs only on window
  // resize. A container that settles after mount (the text panel, late layout, Safari's first layout)
  // left the bitmap squeezed. Observe the container and re-sync on the next frame, one pending frame at a time.
  useEffect(() => {
    const node = hostRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let lastWidth = -1;
    const ro = new ResizeObserver(() => {
      const width = node.clientWidth;
      if (Math.abs(width - lastWidth) < settings.resize_min_delta_px) return;
      lastWidth = width;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        // Same call page-flip makes on window resize (UI.onResize): re-syncs the canvas bitmap.
        flipRef.current?.getUI().update();
      });
    });
    ro.observe(node);
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [status, settings.resize_min_delta_px]);

  useEffect(() => {
    if (!seen) return;
    let disposed = false;
    let pf: PageFlip | null = null;

    (async () => {
      try {
        setStatus("loading");
        setErrorMessage(null);

        const raster = await rasterizePreview(previewPdfUrl, coverImageUrl, settings, () => disposed);
        if (!raster || disposed || !hostRef.current) return;

        const { PageFlip: PageFlipCtor } = await import("page-flip");
        if (disposed || !hostRef.current) return;

        const stage = document.createElement("div");
        stage.setAttribute("data-testid", "book-preview-stage");
        hostRef.current.replaceChildren(stage);

        const reducedMotion =
          typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

        pf = new PageFlipCtor(stage, {
          width: settings.page_width_px,
          height: settings.page_height_px,
          size: "stretch",
          minWidth: settings.min_width_px,
          maxWidth: settings.max_width_px,
          minHeight: settings.min_height_px,
          maxHeight: settings.max_height_px,
          autoSize: true,
          usePortrait: settings.use_portrait,
          showCover: settings.show_cover,
          drawShadow: true,
          maxShadowOpacity: settings.max_shadow_opacity,
          flippingTime: reducedMotion ? 1 : settings.flipping_time_ms,
          swipeDistance: settings.swipe_distance_px,
          mobileScrollSupport: true,
        });

        pf.on("init", (e) => {
          if (disposed) return;
          const payload = e.data as { page?: number; mode?: Orientation };
          if (typeof payload?.page === "number") {
            setPageIndex(payload.page);
            setDraftPageInput(null);
          }
          if (payload?.mode === "portrait" || payload?.mode === "landscape") setOrientation(payload.mode);
          else if (pf) setOrientation(pf.getOrientation());
        });

        pf.on("flip", (e) => {
          if (disposed) return;
          stopReadAloud();
          clearAnnouncement();
          if (typeof e.data === "number") setPageIndex(e.data);
          else if (pf) setPageIndex(pf.getCurrentPageIndex());
          setDraftPageInput(null);
        });

        pf.on("changeOrientation", (e) => {
          if (disposed) return;
          stopReadAloud();
          clearAnnouncement();
          if (e.data === "portrait" || e.data === "landscape") setOrientation(e.data);
        });

        pf.loadFromImages(raster.images);
        setRenderPaused(pf, !visibleRef.current);
        flipRef.current = pf;
        setTotalPages(raster.images.length);
        setPageBlocks(raster.pageBlocks);
        setPageIndex(0);
        setStatus("ready");
      } catch (err) {
        if (disposed) return;
        console.error("[book-previewer] Failed to load preview:", err);
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : "Could not load book preview.");
      }
    })();

    return () => {
      disposed = true;
      flipRef.current = null;
      if (pf) {
        setRenderPaused(pf, true);
        try {
          pf.destroy();
        } catch (err) {
          console.error("[book-previewer] PageFlip destroy error:", err);
        }
      }
    };
  }, [previewPdfUrl, coverImageUrl, settings, seen, stopReadAloud, clearAnnouncement]);

  const canFlipPrev = status === "ready" && spreadIdx > 0;
  const canFlipNext = status === "ready" && spreadIdx < spreads.length - 1;
  const canZoomIn = status === "ready" && safeZoomIndex < zoomLevels.length - 1;
  const canZoomOut = status === "ready" && safeZoomIndex > 0;
  const canResetZoom = status === "ready" && safeZoomIndex > 0;
  const spreadLabel = formatSpreadLabel(currentSpread, totalPages, settings.show_cover);

  const flipPrev = useCallback(() => {
    if (!flipRef.current || !canFlipPrev) return;
    flipRef.current.flipPrev();
  }, [canFlipPrev]);

  const flipNext = useCallback(() => {
    if (!flipRef.current || !canFlipNext) return;
    flipRef.current.flipNext();
  }, [canFlipNext]);

  const turnToPage = useCallback(
    (targetIdx: number) => {
      if (!flipRef.current || status !== "ready" || totalPages <= 0) return;
      stopReadAloud();
      clearAnnouncement();
      const clamped = Math.min(Math.max(0, targetIdx), totalPages - 1);
      flipRef.current.turnToPage(clamped);
      setPageIndex(clamped);
      setDraftPageInput(null);
    },
    [status, totalPages, stopReadAloud, clearAnnouncement],
  );

  const applyZoomAction = useCallback(
    (action: PreviewZoomAction) => {
      if (status !== "ready") return;
      setZoomIndex((cur) => resolveZoomIndex(cur, action, zoomLevels));
    },
    [status, zoomLevels],
  );

  const handleGoToPageSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const target = parseTargetPageInput(pageInput, totalPages);
      if (target === null) {
        setDraftPageInput(null);
        return;
      }
      turnToPage(target);
      setDraftPageInput(null);
    },
    [pageInput, totalPages, turnToPage],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (status !== "ready" || !flipRef.current) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        flipPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        flipNext();
      } else if (e.key === "Home") {
        e.preventDefault();
        turnToPage(0);
      } else if (e.key === "End" && totalPages > 0) {
        e.preventDefault();
        turnToPage(totalPages - 1);
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          applyZoomAction("zoom_in");
        } else if (e.key === "-") {
          e.preventDefault();
          applyZoomAction("zoom_out");
        } else if (e.key === "0") {
          e.preventDefault();
          applyZoomAction("reset");
        }
      }
    },
    [status, flipPrev, flipNext, totalPages, turnToPage, applyZoomAction],
  );

  const handleToggleTextPanel = useCallback(() => {
    setTextOpen((prev) => {
      const next = !prev;
      if (!next) {
        stopReadAloud();
        clearAnnouncement();
      }
      return next;
    });
  }, [stopReadAloud, clearAnnouncement]);

  const isZoomed = zoom > 1;
  const scaledSpacerStyle =
    isZoomed && stageSize.w > 0 && stageSize.h > 0
      ? { width: `${Math.round(stageSize.w * zoom)}px`, height: `${Math.round(stageSize.h * zoom)}px` }
      : undefined;
  const scaledInnerStyle = isZoomed
    ? {
        transform: `scale(${zoom})`,
        transformOrigin: "top left",
        ...(stageSize.w > 0 && stageSize.h > 0 ? { width: `${stageSize.w}px`, height: `${stageSize.h}px` } : {}),
      }
    : undefined;

  return (
    <section
      id={id}
      ref={sectionRef}
      aria-labelledby="book-preview-heading"
      onKeyDown={handleKeyDown}
      data-testid="book-preview-section"
      className="glass-card card-shadow rounded-[32px] border-[1.5px] border-[#fff2e4] p-5 sm:p-8 flex flex-col gap-5 scroll-mt-6"
    >
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-mono font-medium tracking-[0.16em] uppercase text-gray-600">
            Free sample preview
          </p>
          <h2 id="book-preview-heading" className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900">
            {settings.heading}
          </h2>
          <p className="text-xs sm:text-sm text-gray-600">{settings.subheading}</p>
        </div>

        <BookPreviewToolbar
          bookTitle={bookTitle}
          labels={settings.toolbar_labels}
          goToInputId={goToInputId}
          pageInput={pageInput}
          totalPages={totalPages}
          status={status}
          zoom={zoom}
          canZoomIn={canZoomIn}
          canZoomOut={canZoomOut}
          canResetZoom={canResetZoom}
          canFlipPrev={canFlipPrev}
          canFlipNext={canFlipNext}
          onApplyZoom={applyZoomAction}
          onPageInputChange={setDraftPageInput}
          onPageInputReset={() => setDraftPageInput(null)}
          onGoToPageSubmit={handleGoToPageSubmit}
          onFlipPrev={flipPrev}
          onFlipNext={flipNext}
        />
      </div>

      {status === "error" ? (
        <div role="alert" className="rounded-[24px] bg-charcoal text-white p-6 text-sm">
          <p className="font-semibold">Preview unavailable right now</p>
          <p className="mt-1 text-gray-300">{errorMessage ?? "Could not render the preview PDF."}</p>
        </div>
      ) : (
        <div
          data-testid="book-preview-viewport"
          data-zoom={String(zoom)}
          data-zoom-level={String(safeZoomIndex)}
          className={`relative rounded-[24px] bg-charcoal/95 p-4 sm:p-6 min-h-[380px] ${
            isZoomed ? "max-h-[75vh] overflow-auto thin-scrollbar" : "flex flex-col items-center justify-center overflow-hidden"
          }`}
        >
          {status === "loading" && (
            <p className="text-sm font-mono text-gray-300 py-16" role="status">
              Loading book preview&hellip;
            </p>
          )}
          <div style={scaledSpacerStyle} className={isZoomed ? "mx-auto" : "w-full"}>
            <div style={scaledInnerStyle}>
              <div
                ref={hostRef}
                tabIndex={status === "ready" ? 0 : -1}
                role="region"
                aria-label={settings.toolbar_labels.region_aria_label.replace("{title}", bookTitle)}
                data-orientation={orientation}
                className={`w-full flex justify-center ${status === "loading" ? "invisible" : ""}`}
              />
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-700">
        <p aria-live="polite" data-testid="book-preview-page-label" className="font-mono font-medium">
          {status === "ready" ? spreadLabel : status === "loading" ? "Preparing pages…" : ""}
        </p>
        <p className="text-gray-600">Drag a corner, swipe, or use Prev / Next (Arrow keys)</p>
      </div>

      {status === "ready" && spreadAccessible.pages.length > 0 && (
        <BookPreviewAccessibleCard
          panelId={accessiblePanelId}
          textOpen={textOpen}
          spreadCount={currentSpread.length}
          pages={spreadAccessible.pages}
          activeChunkId={activeChunkId}
          playbackState={playbackState}
          currentRate={currentRate}
          showReadAloudControls={settings.read_aloud.enabled && speechSupported && spreadAccessible.chunks.length > 0}
          speechAnnouncement={speechAnnouncement}
          readAloudSettings={settings.read_aloud}
          textStructureSettings={settings.text_structure}
          onTogglePanel={handleToggleTextPanel}
          onPlayPauseResume={handlePlayPauseResume}
          onStop={stopReadAloud}
          onCycleSpeed={handleCycleSpeed}
        />
      )}
    </section>
  );
}
