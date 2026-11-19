"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Orientation, PageFlip } from "page-flip";
import type { BookPreviewSettings } from "../../../../payments/src/settings_registry";
import { ArrowIcon } from "../brand/brand";

interface PdfPageLike {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): {
    promise: Promise<void>;
    cancel?: () => void;
  };
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
}

interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
  destroy?(): Promise<void>;
}

export interface BookPreviewerProps {
  previewPdfUrl: string;
  coverImageUrl?: string | null;
  bookTitle: string;
  settings: BookPreviewSettings;
}

/** Build StPageFlip spread groups matching PageCollection.createSpread(). */
export function buildSpreadGroups(totalPages: number, orientation: Orientation, showCover: boolean): number[][] {
  if (totalPages <= 0) return [];
  if (orientation === "portrait") {
    return Array.from({ length: totalPages }, (_, i) => [i]);
  }
  const spreads: number[][] = [];
  let start = 0;
  if (showCover) {
    spreads.push([0]);
    start = 1;
  }
  for (let i = start; i < totalPages; i += 2) {
    if (i < totalPages - 1) spreads.push([i, i + 1]);
    else spreads.push([i]);
  }
  return spreads;
}

export function spreadIndexForPage(spreads: number[][], pageIndex: number): number {
  const idx = spreads.findIndex((group) => group.includes(pageIndex));
  return idx >= 0 ? idx : 0;
}

export function formatSpreadLabel(spread: number[], totalPages: number, showCover: boolean): string {
  if (totalPages <= 0 || spread.length === 0) return "";
  if (spread.length === 1) {
    const p = spread[0] + 1;
    if (showCover && p === 1) return `Front cover · Page 1 of ${totalPages}`;
    if (showCover && p === totalPages && totalPages > 1) return `Back cover · Page ${p} of ${totalPages}`;
    return `Page ${p} of ${totalPages}`;
  }
  return `Pages ${spread[0] + 1}–${spread[spread.length - 1] + 1} of ${totalPages}`;
}

type Rasterized = { images: string[]; texts: string[] };

type RenderLike = { drawFrame: () => void };

/** page-flip 2.0.7 has no pause or stop. Its requestAnimationFrame loop redraws the canvas every frame and destroy() does not
 *  cancel it. Pausing replaces drawFrame on the library's render object with a no-op, so the per-frame redraw stops. Resuming
 *  deletes that override so the library's own method returns. */
function setRenderPaused(flip: PageFlip | null, paused: boolean): void {
  const render = (flip as unknown as { render?: RenderLike } | null)?.render;
  if (!render) return;
  if (paused) render.drawFrame = () => {};
  else delete (render as Partial<RenderLike>).drawFrame;
}

/** Renders the first max_preview_pages pages to PNG data URLs (page 1 is the registry cover when one is set) and their text.
 *  The pdf.js document is destroyed before this returns, so only the images stay in memory. Returns null when cancelled. */
async function rasterizePreview(
  previewPdfUrl: string,
  coverImageUrl: string | null,
  settings: BookPreviewSettings,
  isCancelled: () => boolean,
): Promise<Rasterized | null> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = settings.pdf_worker_src;
  const doc = (await pdfjs.getDocument(previewPdfUrl).promise) as unknown as PdfDocLike;
  try {
    const count = Math.min(doc.numPages, settings.max_preview_pages);
    const images: string[] = [];
    const texts: string[] = [];
    for (let i = 1; i <= count; i++) {
      if (isCancelled()) return null;
      const pdfPage = await doc.getPage(i);
      if (isCancelled()) return null;
      const baseVp = pdfPage.getViewport({ scale: 1 });
      const targetScale = (settings.page_width_px * settings.render_scale) / Math.max(baseVp.width, 1);
      const vp = pdfPage.getViewport({ scale: targetScale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable");

      if (i === 1 && coverImageUrl) {
        images.push(coverImageUrl);
      } else {
        await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
        images.push(canvas.toDataURL("image/png"));
      }

      try {
        const tc = await pdfPage.getTextContent();
        texts.push(
          tc.items
            .map((it) => it.str ?? "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
        );
      } catch {
        texts.push("");
      }
    }
    return { images, texts };
  } finally {
    await doc.destroy?.();
  }
}

export default function BookPreviewer({
  previewPdfUrl,
  coverImageUrl = null,
  bookTitle,
  settings,
}: BookPreviewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const flipRef = useRef<PageFlip | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  const [pageTexts, setPageTexts] = useState<string[]>([]);
  const sectionRef = useRef<HTMLElement>(null);
  // Mount on first view; without IntersectionObserver (old browsers, jsdom) mount at once. Afterwards, pause the page-flip
  // redraw while the section is out of view and resume it when the section returns.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  const visibleRef = useRef(true);

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
    if (!seen) return;
    let disposed = false;
    let pf: PageFlip | null = null;

    (async () => {
      try {
        setStatus("loading");
        setErrorMessage(null);

        const raster = await rasterizePreview(previewPdfUrl, coverImageUrl, settings, () => disposed);
        if (!raster) return;

        if (disposed || !hostRef.current) return;

        const { PageFlip: PageFlipCtor } = await import("page-flip");
        if (disposed || !hostRef.current) return;

        // PageFlip.destroy() calls this.block.remove(); mount on an imperative child node
        // so React's StrictMode double-mount never loses hostRef.current.
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
          if (typeof payload?.page === "number") setPageIndex(payload.page);
          if (payload?.mode === "portrait" || payload?.mode === "landscape") setOrientation(payload.mode);
          else if (pf) setOrientation(pf.getOrientation());
        });

        pf.on("flip", (e) => {
          if (disposed) return;
          if (typeof e.data === "number") setPageIndex(e.data);
          else if (pf) setPageIndex(pf.getCurrentPageIndex());
        });

        pf.on("changeOrientation", (e) => {
          if (disposed) return;
          if (e.data === "portrait" || e.data === "landscape") setOrientation(e.data);
        });

        pf.loadFromImages(raster.images);
        setRenderPaused(pf, !visibleRef.current);
        flipRef.current = pf;
        setTotalPages(raster.images.length);
        setPageTexts(raster.texts);
        setPageIndex(0);
        setStatus("ready");
      } catch (err) {
        if (disposed) return;
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
        } catch {
          /* ignore teardown errors if container was unmounted */
        }
      }
    };
  }, [previewPdfUrl, coverImageUrl, settings, seen]);

  const spreads = buildSpreadGroups(totalPages, orientation, settings.show_cover);
  const spreadIdx = spreadIndexForPage(spreads, pageIndex);
  const currentSpread = spreads[spreadIdx] ?? [];
  const canFlipPrev = status === "ready" && spreadIdx > 0;
  const canFlipNext = status === "ready" && spreadIdx < spreads.length - 1;
  const spreadLabel = formatSpreadLabel(currentSpread, totalPages, settings.show_cover);

  const flipPrev = useCallback(() => {
    if (!flipRef.current || !canFlipPrev) return;
    flipRef.current.flipPrev();
  }, [canFlipPrev]);

  const flipNext = useCallback(() => {
    if (!flipRef.current || !canFlipNext) return;
    flipRef.current.flipNext();
  }, [canFlipNext]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (status !== "ready" || !flipRef.current) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        flipPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        flipNext();
      } else if (e.key === "Home") {
        e.preventDefault();
        flipRef.current.turnToPage(0);
        setPageIndex(0);
      } else if (e.key === "End" && totalPages > 0) {
        e.preventDefault();
        flipRef.current.turnToPage(totalPages - 1);
        setPageIndex(totalPages - 1);
      }
    },
    [status, flipPrev, flipNext, totalPages],
  );

  const visibleExcerpt = currentSpread
    .map((idx) => pageTexts[idx] ?? "")
    .filter(Boolean)
    .join(" — ");

  return (
    <section
      ref={sectionRef}
      aria-labelledby="book-preview-heading"
      onKeyDown={handleKeyDown}
      data-testid="book-preview-section"
      className="glass-card card-shadow rounded-[32px] border-[1.5px] border-[#fff2e4] p-5 sm:p-8 flex flex-col gap-5"
    >
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-mono font-medium tracking-[0.16em] uppercase text-gray-600">
            Free sample preview
          </p>
          <h2 id="book-preview-heading" className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900">
            {settings.heading}
          </h2>
          <p className="text-xs sm:text-sm text-gray-600">{settings.subheading}</p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto" role="group" aria-label={`Preview navigation for ${bookTitle}`}>
          <button
            type="button"
            onClick={flipPrev}
            disabled={!canFlipPrev}
            aria-label="Previous preview page"
            className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2.5 rounded-full border border-[#dcc7b4] bg-white text-sm font-semibold text-gray-900 hover:bg-[#faf5ee] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowIcon className="w-3.5 h-3.5 rotate-180" />
            <span>Prev</span>
          </button>
          <button
            type="button"
            onClick={flipNext}
            disabled={!canFlipNext}
            aria-label="Next preview page"
            className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2.5 rounded-full bg-charcoal hover:bg-[#2a2a2a] text-sm font-semibold text-white disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
          >
            <span>Next</span>
            <ArrowIcon />
          </button>
        </div>
      </div>

      {status === "error" ? (
        <div role="alert" className="rounded-[24px] bg-charcoal text-white p-6 text-sm">
          <p className="font-semibold">Preview unavailable right now</p>
          <p className="mt-1 text-gray-300">{errorMessage ?? "Could not render the preview PDF."}</p>
        </div>
      ) : (
        <div className="relative rounded-[24px] bg-charcoal/95 p-4 sm:p-6 flex flex-col items-center justify-center overflow-hidden min-h-[380px]">
          {status === "loading" && (
            <p className="text-sm font-mono text-gray-300 py-16" role="status">
              Loading book preview&hellip;
            </p>
          )}
          <div
            ref={hostRef}
            tabIndex={status === "ready" ? 0 : -1}
            role="region"
            aria-label={`Interactive page-turning preview of ${bookTitle}. Use Left and Right arrow keys or Prev and Next buttons to turn pages.`}
            data-orientation={orientation}
            className={`w-full flex justify-center ${status === "loading" ? "sr-only" : ""}`}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-700">
        <p aria-live="polite" data-testid="book-preview-page-label" className="font-mono font-medium">
          {status === "ready" ? spreadLabel : status === "loading" ? "Preparing pages…" : ""}
        </p>
        <p className="text-gray-600">Drag a corner, swipe, or use Prev / Next (Arrow keys)</p>
      </div>

      {status === "ready" && visibleExcerpt && (
        <details className="text-xs text-gray-700 rounded-2xl border border-[#e8dacb] bg-white/70 px-4 py-3">
          <summary className="cursor-pointer font-semibold text-gray-800 select-none">
            Accessible text for visible preview {currentSpread.length > 1 ? "pages" : "page"}
          </summary>
          <p className="mt-2 leading-relaxed text-gray-700" data-testid="book-preview-accessible-text">
            {visibleExcerpt}
          </p>
        </details>
      )}
    </section>
  );
}
