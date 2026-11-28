"use client";

/**
 * Manuscript review client (Wave 6.1) — ports the legacy static reader's
 * flow into the React lifecycle: item-by-item stepper over RLS-fetched
 * review items, answers persisted through the submitReviewAnswerAction
 * Server Action (RLS identity), and a PDF.js page-flip viewer driven by a
 * server-minted signed URL. PDF.js + its worker load lazily inside
 * useEffect so nothing blocks first paint; the worker is served locally
 * from /pdfjs (no CDN dependency on the review funnel).
 *
 * Visuals follow the Astryx system: cream canvas (#FAF7F2), charcoal
 * containers (neu-card), peach accents, sans-serif headings (font-sans).
 */
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { m, useReducedMotion } from "framer-motion";
import { BrandButton, BrandFooter, BrandFrame, BrandWordmark } from "../../../src/components/brand/brand";
import { submitReviewAnswerAction } from "./actions";
import type { ReviewItemView } from "./page";
import { viewerPageFor } from "../../../src/lib/review-anchor";

const EASE = [0.16, 1, 0.3, 1] as const;

interface SavedAnswer {
  choice: string | null;
  freeText: string | null;
}

export interface ReviewClientProps {
  items: ReviewItemView[];
  saved: Record<string, SavedAnswer>;
  pdfUrl: string | null;
  bookTitle: string;
  supportEmail?: string;
}

type PdfDoc = {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
};
type PdfPage = {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): {
    promise: Promise<void>;
    cancel(): void;
  };
  getTextContent(): Promise<{ items: { str?: string }[] }>;
};

const KIND_LABEL: Record<string, string> = {
  contradiction: "Contradiction",
  confirm: "Confirm",
  source: "Source",
  premise: "Premise",
};

export default function ReviewClient({ items, saved, pdfUrl, bookTitle, supportEmail }: ReviewClientProps) {
  const reduced = useReducedMotion();

  const firstOpen = items.findIndex((it) => !saved[it.id]);
  const [index, setIndex] = useState(firstOpen === -1 ? items.length - 1 : firstOpen);
  const [answers, setAnswers] = useState<Record<string, SavedAnswer>>(saved);
  const [choice, setChoice] = useState<string>(saved[items[firstOpen === -1 ? items.length - 1 : firstOpen]?.id]?.choice ?? "");
  const [freeText, setFreeText] = useState<string>(saved[items[firstOpen === -1 ? items.length - 1 : firstOpen]?.id]?.freeText ?? "");
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- PDF.js viewer state (React lifecycle, lazily loaded) ----
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PdfDoc | null>(null);
  const seqRef = useRef(0);
  // Stepper focus: after Back / Save & next, move focus to the new question so
  // screen readers announce it (instead of leaving it on the pressed button).
  const questionRef = useRef<HTMLHeadingElement>(null);
  const focusQuestionRef = useRef(false);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [folio, setFolio] = useState<number | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  // Visible notice when a question's anchor is outside the PDF (the viewer then shows page 1, and says so).
  const [anchorNotice, setAnchorNotice] = useState<string | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  // Text layer of a specific page; only exposed while that page is the one shown.
  const [pageText, setPageText] = useState<{ page: number; text: string } | null>(null);

  const item = items[index];
  const answeredCount = items.filter((it) => answers[it.id]).length;
  const allAnswered = answeredCount === items.length;
  const isNoAnswerNeeded = /no answer needed/i.test(item?.question ?? "");
  const hasBlank = /_{3,}/.test(item?.question ?? "");

  // In-memory client draft cache (Task 4: zero egress on navigation, prevents data loss)
  const draftsRef = useRef<Record<string, SavedAnswer>>({});

  function showItem(i: number, saveCurrentDraft = true) {
    if (saveCurrentDraft && items[index]) {
      draftsRef.current[items[index].id] = {
        choice: choice.trim() || null,
        freeText: freeText.trim() || null,
      };
    }
    const target = items[i];
    setIndex(i);
    const cached = draftsRef.current[target.id];
    setChoice(cached?.choice ?? answers[target.id]?.choice ?? "");
    setFreeText(cached?.freeText ?? answers[target.id]?.freeText ?? "");
    setError(null);
    setJustSaved(false);
    focusQuestionRef.current = true;
    setAnchorNotice(null);
    const doc = docRef.current;
    if (doc && target.anchorPage !== null) {
      const view = viewerPageFor(target.anchorPage, doc.numPages, target.code);
      setPage(view.page);
      setAnchorNotice(view.notice);
    }
  }

  useEffect(() => {
    return () => {
      if (navTimerRef.current !== null) {
        clearTimeout(navTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!focusQuestionRef.current) return;
    focusQuestionRef.current = false;
    // preventScroll: saveAndNext already scrolls to the top.
    questionRef.current?.focus({ preventScroll: true });
  }, [index]);

  // Opens the document at the first unanswered question. An Effect Event reads the current items and answers when it runs, so
  // the load effect below depends only on pdfUrl and does not rely on the hydrated props keeping their identity.
  const openAtFirstUnanswered = useEffectEvent((numPages: number) => {
    const start = items.findIndex((it) => !answers[it.id]);
    const opening = items[start === -1 ? 0 : start];
    // An anchor outside the loaded PDF still opens a real page (page 0 renders nothing), and the creator is told why.
    const view = viewerPageFor(opening?.anchorPage ?? null, numPages, opening?.code ?? "");
    setPage(view.page);
    setAnchorNotice(view.notice);
  });

  // Load the document once per pdfUrl; re-render on page/zoom changes.
  useEffect(() => {
    if (!pdfUrl) return;
    let disposed = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
        const doc = (await pdfjs.getDocument(pdfUrl).promise) as unknown as PdfDoc;
        if (disposed) return;
        docRef.current = doc;
        setTotal(doc.numPages);
        setViewerReady(true);
        openAtFirstUnanswered(doc.numPages);
      } catch (err) {
        if (!disposed) setViewerError(`Could not load the book (${err instanceof Error ? err.message : "unknown error"}). You can still answer from the questions shown.`);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [pdfUrl]);

  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || !page) return;
    const my = ++seqRef.current;
    let task: { promise: Promise<void>; cancel(): void } | null = null;
    (async () => {
      const pdfPage = await doc.getPage(page);
      if (my !== seqRef.current) return;
      const vp1 = pdfPage.getViewport({ scale: 1 });
      const box = canvas.parentElement?.getBoundingClientRect();
      const fitW = box ? (box.width - 24) / vp1.width : 1;
      const fitH = box ? (box.height - 24) / vp1.height : 1;
      const fit = window.innerWidth <= 900 ? Math.min(fitW, fitH * 2.2) : Math.min(fitW, fitH);
      const scale = fit * zoom;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = pdfPage.getViewport({ scale: scale * dpr });
      const cssVp = pdfPage.getViewport({ scale });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${Math.floor(cssVp.width)}px`;
      canvas.style.height = `${Math.floor(cssVp.height)}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      task = pdfPage.render({ canvasContext: ctx, viewport: vp });
      await task.promise;
    })().catch((err: unknown) => {
      // A superseded render (page/zoom changed) is cancelled on purpose — ignore it.
      if (my !== seqRef.current || (err as { name?: string })?.name === "RenderingCancelledException") return;
      console.error("[review] page render failed:", err);
      setViewerError("Could not display this page. You can still answer from the questions shown.");
    });
    return () => {
      task?.cancel();
    };
  }, [page, zoom, viewerReady]);

  // Screen-reader text for the canvas: the real text layer of the shown page.
  useEffect(() => {
    const doc = docRef.current;
    if (!doc || !page) return;
    let cancelled = false;
    (async () => {
      const pdfPage = await doc.getPage(page);
      const content = await pdfPage.getTextContent();
      if (cancelled) return;
      setPageText({ page, text: content.items.map((it) => it.str ?? "").join(" ").replace(/\s+/g, " ").trim() });
    })().catch((err: unknown) => {
      console.error("[review] page text extraction failed:", err);
      if (!cancelled) setPageText({ page, text: "" });
    });
    return () => {
      cancelled = true;
    };
  }, [page, viewerReady]);

  // Folio detection (best-effort): printed page numbers from the PDF text.
  useEffect(() => {
    const doc = docRef.current;
    if (!doc || folio !== null) return;
    let cancelled = false;
    (async () => {
      try {
        for (let p = 2; p <= Math.min(total, 20); p++) {
          if (cancelled) return;
          const pdfPage = await doc.getPage(p);
          if (cancelled) return;
          const tc = await pdfPage.getTextContent();
          if (cancelled) return;
          const strs = tc.items.map((t) => t.str ?? "").filter((s) => s.trim());
          const cands = [...strs.slice(-2), ...strs.slice(0, 2)];
          for (const c of cands) {
            if (/^\d{1,3}$/.test(c.trim())) {
              const n = parseInt(c, 10);
              if (n > 0 && n < total) {
                const off = p - n;
                if (off >= 0 && off < 20) {
                  setFolio(off);
                  return;
                }
              }
            }
          }
        }
      } catch (err) {
        // Folio detection is best-effort — log and fall back to raw page numbers.
        if (!cancelled) console.warn("[review] folio detection failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [total, folio]);

  async function saveAndNext() {
    // Immediate synchronous double-click guard
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);

    const a = choice.trim() || null;
    const f = freeText.trim() || null;
    if (!a && !f) {
      busyRef.current = false;
      setBusy(false);
      setError(
        isNoAnswerNeeded
          ? "Type OK to confirm you've read this, then continue."
          : "Choose an option or write the correct fact before continuing.",
      );
      return;
    }

    // Zero-egress optimization (Task 4): normalize empty string vs null
    const currentSaved = answers[item.id];
    const savedChoice = currentSaved?.choice?.trim() || null;
    const savedFreeText = currentSaved?.freeText?.trim() || null;
    if (currentSaved && savedChoice === a && savedFreeText === f) {
      delete draftsRef.current[item.id];
      setJustSaved(true);
      const nextOpen = items.findIndex((it, k) => k > index && !answers[it.id]);
      if (navTimerRef.current !== null) clearTimeout(navTimerRef.current);
      navTimerRef.current = setTimeout(() => {
        showItem(nextOpen !== -1 ? nextOpen : (index < items.length - 1 ? index + 1 : index), false);
        if (typeof window !== "undefined") window.scrollTo?.(0, 0);
        busyRef.current = false;
        setBusy(false);
      }, 300);
      return;
    }

    setError(null);
    let willNavigate = false;
    try {
      const res = await submitReviewAnswerAction(item.id, a, f);
      if (!res.ok) {
        setError(res.error ?? "Could not save — please try again.");
        return;
      }
      delete draftsRef.current[item.id];
      const updated = { ...answers, [item.id]: { choice: a, freeText: f } };
      setAnswers(updated);
      setJustSaved(true);
      willNavigate = true;
      const nextOpen = items.findIndex((it, k) => k > index && !updated[it.id]);
      if (navTimerRef.current !== null) clearTimeout(navTimerRef.current);
      navTimerRef.current = setTimeout(() => {
        showItem(nextOpen !== -1 ? nextOpen : index, false);
        if (typeof window !== "undefined") window.scrollTo?.(0, 0);
        busyRef.current = false;
        setBusy(false);
      }, 500);
    } catch (err) {
      // Network/runtime rejection: keep the typed answer and let the creator retry.
      console.error("[review] save failed:", err);
      setError("Could not save — check your connection and try again.");
    } finally {
      if (!willNavigate) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  const printed = (p: number) => (folio !== null ? Math.max(1, p - folio) : p);

  if (allAnswered) {
    return (
      <BrandFrame outerClassName="justify-between">
        <header className="flex items-center justify-between">
          <BrandWordmark href="/creator/dashboard" label="Creator dashboard" />
        </header>
        <main className="mx-auto w-full max-w-[680px] text-center">
          <m.div
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } }}
            className="neu-card rounded-[32px] p-6 sm:p-8"
          >
            <p className="text-[11px] font-mono font-bold uppercase tracking-[0.12em] text-[#296E50]">Review complete</p>
            <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight text-gray-900">
              Every answer is saved and logged
            </h1>
            <p className="mt-3 text-base text-gray-700">
              Thank you — your manuscript review is done. Continue to the legal consents to move your book toward release.
            </p>
            <BrandButton href="/creator/consents" className="mt-6 mx-auto">
              Continue to consents →
            </BrandButton>
          </m.div>
        </main>
        <BrandFooter>
          <a href="/privacy.html" className="hover:text-gray-700 transition-colors">Privacy Policy</a>
          <a href="/terms.html" className="hover:text-gray-700 transition-colors">Terms of Service</a>
          {supportEmail ? <span>{supportEmail}</span> : null}
        </BrandFooter>
      </BrandFrame>
    );
  }

  return (
    <BrandFrame outerClassName="justify-between">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <BrandWordmark href="/creator/dashboard" label="Creator dashboard" />
        <BrandButton
          variant="secondary"
          href="/creator/dashboard"
          data-testid="review-back-to-dashboard"
          className="min-h-11 px-4 py-2"
        >
          ← Back to dashboard
        </BrandButton>
      </header>

      <main className="mx-auto w-full max-w-[1100px]">
        <p className="mb-2 text-[11px] sm:text-xs font-mono font-medium uppercase tracking-[0.16em] text-gray-600">
          Creator Portal
        </p>
        <h1 className="text-3xl sm:text-4xl font-bold leading-[1.15] tracking-tight text-gray-900">Manuscript review</h1>
        <p className="mt-2 mb-4 text-sm text-gray-700">{bookTitle} — confirm quotes and facts, then sign off.</p>

        {/* Progress */}
        <p className="mb-1 text-sm font-medium text-gray-700" aria-live="polite">
          {answeredCount} of {items.length} confirmed
        </p>
        <div className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-[#dcc7b4]/50" aria-hidden>
          <div
            className="h-full rounded-full bg-[#E8622C] transition-[width] duration-500"
            style={{ width: `${items.length ? (answeredCount / items.length) * 100 : 0}%` }}
          />
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[380px_1fr]">
          {/* Question card */}
          <m.section
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.06 } }}
            className="neu-card self-start rounded-[32px] p-6"
            aria-label="Review question"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-mono font-bold uppercase tracking-[0.12em] text-[#b3401e]">{item.code}</span>
              <span className="text-xs font-semibold text-gray-600">{KIND_LABEL[item.kind] ?? item.kind}</span>
            </div>
            <h2
              id="review-question-text"
              ref={questionRef}
              tabIndex={-1}
              className="text-base font-medium leading-relaxed text-gray-900 rounded-md focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#E8622C]"
            >
              {item.question}
            </h2>

            {hasBlank && (
              <p className="mt-3 rounded-2xl bg-[#fff2e4]/60 p-3 text-sm text-gray-700">
                Some choices have a blank (<b>____</b>) for a figure. Pick the closest one, then complete it in the <b>Other / the correct fact</b> box below —
                write amounts in full, e.g. &ldquo;about $12,000 a year, covered by dividends&rdquo;.
              </p>
            )}
            {item.options.length === 0 && !isNoAnswerNeeded && (
              <p className="mt-3 rounded-2xl bg-[#fff2e4]/60 p-3 text-sm text-gray-700">
                This one has <b>no preset choices</b> on purpose — write the actual figure or fact in the box below.
              </p>
            )}
            {isNoAnswerNeeded && (
              <p className="mt-3 rounded-2xl bg-[#fff2e4]/60 p-3 text-sm text-gray-700">
                <b>No answer is needed</b> — the editor already resolved this. Just type <b>OK</b> below to confirm you understand.
              </p>
            )}

            {item.options.length > 0 && (
              <div
                className="mt-4 flex flex-col gap-2"
                role="radiogroup"
                aria-labelledby="review-question-text"
              >
                {item.options.map((opt) => (
                  <label
                    key={opt.key}
                    className="flex cursor-pointer items-start gap-2.5 rounded-2xl border border-[#dcc7b4] bg-white p-3 text-sm text-gray-900 transition-colors has-[:checked]:border-[#E8622C] has-[:checked]:bg-[#fff2e4]/60"
                  >
                    <input
                      type="radio"
                      name={`opt-${item.id}`}
                      value={opt.key}
                      checked={choice === opt.key}
                      onChange={() => setChoice(opt.key)}
                      className="mt-0.5 accent-[#E8622C]"
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
            )}

            <label htmlFor="freetext" className="mt-4 block text-sm font-semibold text-gray-900">
              Other / the correct fact
            </label>
            <p className="mt-1 text-xs text-gray-600">
              Use this box for anything the choices don&apos;t cover — especially blanks: write the dollar figure and the reason in full.
            </p>
            <textarea
              id="freetext"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              rows={3}
              aria-describedby="review-question-text"
              className="mt-2 w-full rounded-2xl border border-[#dcc7b4] bg-white px-4 py-3 text-base text-gray-900 placeholder:text-gray-500 hover:border-[#bfa48b] transition-colors focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#E8622C]"
              placeholder="Write the correct fact here…"
            />

            {error && (
              <p className="mt-3 text-sm font-medium text-[#b3401e]" role="alert">
                {error}
              </p>
            )}
            {justSaved && !error && (
              <p className="mt-3 text-sm text-[#296E50]" aria-live="polite">
                Saved — you can safely stop here and continue later; your answer is already recorded.
              </p>
            )}

            <div className="mt-4 flex items-center justify-between gap-3">
              <BrandButton
                variant="secondary"
                type="button"
                onClick={() => index > 0 && showItem(index - 1)}
                disabled={index === 0 || busy}
                className="min-h-11 px-5"
              >
                ← Back
              </BrandButton>
              <BrandButton
                type="button"
                onClick={() => void saveAndNext()}
                disabled={busy}
                className="min-h-11 self-auto px-6"
              >
                {busy ? "Saving…" : "Save & next"}
              </BrandButton>
            </div>
          </m.section>

          {/* PDF reader */}
          <m.section
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 32 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.12 } }}
            className="neu-card flex min-h-[70vh] flex-col rounded-[32px] p-6"
            aria-label="Book excerpt"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-mono font-semibold uppercase tracking-[0.08em] text-gray-600">
                The book — review copy
              </span>
              <span className="flex items-center gap-1.5">
                <BrandButton
                  variant="secondary"
                  type="button"
                  onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))}
                  aria-label="Zoom out"
                  className="min-h-11 min-w-11 px-2.5 py-1"
                >
                  −
                </BrandButton>
                <BrandButton
                  variant="secondary"
                  type="button"
                  onClick={() => setZoom(1)}
                  className="min-h-11 px-2.5 py-1 text-xs"
                >
                  Reset
                </BrandButton>
                <BrandButton
                  variant="secondary"
                  type="button"
                  onClick={() => setZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))}
                  aria-label="Zoom in"
                  className="min-h-11 min-w-11 px-2.5 py-1"
                >
                  +
                </BrandButton>
              </span>
            </div>

            <div className="flex flex-1 items-center justify-center overflow-auto rounded-2xl bg-white/80 p-3">
              {!pdfUrl ? (
                <p className="max-w-[420px] text-center text-sm text-gray-600">
                  No review PDF was attached to your product yet. You can still answer from the questions shown.
                </p>
              ) : viewerError ? (
                <p className="max-w-[420px] text-center text-sm text-[#b3401e]">{viewerError}</p>
              ) : !viewerReady ? (
                <p className="text-sm text-gray-600">Loading the book…</p>
              ) : (
                <>
                  <canvas
                    ref={canvasRef}
                    role="img"
                    aria-label={`Book page ${printed(page)} of ${printed(total)}, shown for question ${item.code}`}
                    aria-describedby="review-page-text review-question-text"
                    className="max-w-full rounded-lg shadow-[0_2px_10px_rgba(43,37,32,0.08)]"
                  />
                  <div id="review-page-text" className="sr-only">
                    {pageText?.page !== page
                      ? `Loading the text of book page ${printed(page)}…`
                      : pageText.text
                        ? `Text of book page ${printed(page)}: ${pageText.text}`
                        : `Book page ${printed(page)} has no extractable text.`}
                  </div>
                </>
              )}
            </div>

            {anchorNotice && (
              <p role="status" className="mt-3 text-center text-sm text-[#b3401e]">
                {anchorNotice}
              </p>
            )}

            {viewerReady && (
              <div className="mt-3 flex items-center justify-center gap-3">
                <BrandButton
                  variant="secondary"
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="min-h-11 px-3 py-1"
                >
                  ‹ Prev
                </BrandButton>
                <span className="text-sm text-gray-600">
                  book page <b className="text-gray-900">{printed(page)}</b> of <span>{printed(total)}</span>
                </span>
                <BrandButton
                  variant="secondary"
                  type="button"
                  onClick={() => setPage((p) => Math.min(total, p + 1))}
                  disabled={page >= total}
                  className="min-h-11 px-3 py-1"
                >
                  Next ›
                </BrandButton>
              </div>
            )}
          </m.section>
        </div>
      </main>

      <BrandFooter>
        <a href="/privacy.html" className="hover:text-gray-700 transition-colors">Privacy Policy</a>
        <a href="/terms.html" className="hover:text-gray-700 transition-colors">Terms of Service</a>
        {supportEmail ? <span>{supportEmail}</span> : null}
      </BrandFooter>
    </BrandFrame>
  );
}
