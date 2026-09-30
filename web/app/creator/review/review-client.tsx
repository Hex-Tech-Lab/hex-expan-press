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
 * containers (neu-card), peach accents, Fraunces headings.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { m, useReducedMotion } from "framer-motion";
import { submitReviewAnswerAction } from "./actions";
import type { ReviewItemView } from "./page";

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

export default function ReviewClient({ items, saved, pdfUrl, bookTitle }: ReviewClientProps) {
  const reduced = useReducedMotion();

  const firstOpen = items.findIndex((it) => !saved[it.id]);
  const [index, setIndex] = useState(firstOpen === -1 ? items.length - 1 : firstOpen);
  const [answers, setAnswers] = useState<Record<string, SavedAnswer>>(saved);
  const [choice, setChoice] = useState<string>(saved[items[firstOpen === -1 ? items.length - 1 : firstOpen]?.id]?.choice ?? "");
  const [freeText, setFreeText] = useState<string>(saved[items[firstOpen === -1 ? items.length - 1 : firstOpen]?.id]?.freeText ?? "");
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [busy, setBusy] = useState(false);

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
  const [viewerReady, setViewerReady] = useState(false);
  const [pageText, setPageText] = useState("");

  const item = items[index];
  const answeredCount = items.filter((it) => answers[it.id]).length;
  const allAnswered = answeredCount === items.length;
  const isNoAnswerNeeded = /no answer needed/i.test(item?.question ?? "");
  const hasBlank = /_{3,}/.test(item?.question ?? "");

  function showItem(i: number) {
    const target = items[i];
    setIndex(i);
    setChoice(answers[target.id]?.choice ?? "");
    setFreeText(answers[target.id]?.freeText ?? "");
    setError(null);
    setJustSaved(false);
    focusQuestionRef.current = true;
    const anchor = target.anchorPage;
    if (docRef.current && anchor && anchor >= 1 && anchor <= total) setPage(anchor);
  }

  useEffect(() => {
    if (!focusQuestionRef.current) return;
    focusQuestionRef.current = false;
    // preventScroll: saveAndNext already scrolls to the top.
    questionRef.current?.focus({ preventScroll: true });
  }, [index]);

  // Load the document once; re-render on page/zoom changes.
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
        const start = items.findIndex((it) => !answers[it.id]);
        const anchor = items[start === -1 ? 0 : start]?.anchorPage;
        setPage(anchor && anchor >= 1 && anchor <= doc.numPages ? anchor : 1);
      } catch (err) {
        if (!disposed) setViewerError(`Could not load the book (${err instanceof Error ? err.message : "unknown error"}). You can still answer from the questions shown.`);
      }
    })();
    return () => {
      disposed = true;
    };
    // items/answers are RSC-hydrated props — they never change identity
    // during a client session, and the doc must load exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setPageText(content.items.map((it) => it.str ?? "").join(" ").replace(/\s+/g, " ").trim());
    })().catch((err: unknown) => {
      console.error("[review] page text extraction failed:", err);
      if (!cancelled) setPageText("");
    });
    return () => {
      cancelled = true;
    };
  }, [page, viewerReady]);

  // Folio detection (best-effort): printed page numbers from the PDF text.
  useEffect(() => {
    if (!docRef.current || folio !== null) return;
    (async () => {
      try {
        for (let p = 2; p <= Math.min(total, 20); p++) {
          const pdfPage = await docRef.current!.getPage(p);
          const tc = await pdfPage.getTextContent();
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
        console.warn("[review] folio detection failed:", err);
      }
    })();
  }, [total, folio]);

  async function saveAndNext() {
    const a = choice.trim() || null;
    const f = freeText.trim() || null;
    if (!a && !f) {
      setError(
        isNoAnswerNeeded
          ? "Type OK to confirm you've read this, then continue."
          : "Choose an option or write the correct fact before continuing.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    let res: Awaited<ReturnType<typeof submitReviewAnswerAction>>;
    try {
      res = await submitReviewAnswerAction(item.id, a, f);
    } catch (err) {
      // Network/runtime rejection: keep the typed answer and let the creator retry.
      console.error("[review] save failed:", err);
      setError("Could not save — check your connection and try again.");
      return;
    } finally {
      setBusy(false);
    }
    if (!res.ok) {
      setError(res.error ?? "Could not save — please try again.");
      return;
    }
    const updated = { ...answers, [item.id]: { choice: a, freeText: f } };
    setAnswers(updated);
    setJustSaved(true);
    const nextOpen = items.findIndex((it, k) => k > index && !updated[it.id]);
    window.setTimeout(() => {
      showItem(nextOpen !== -1 ? nextOpen : index);
      window.scrollTo(0, 0);
    }, 500);
  }

  const printed = (p: number) => (folio !== null ? Math.max(1, p - folio) : p);

  if (allAnswered) {
    return (
      <div className="mx-auto max-w-[680px] px-5 py-16 text-center">
        <m.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } }}
          className="neu-card rounded-[14px] p-(--space-6)"
        >
          <p className="text-[length:var(--font-size-2xs)] font-bold uppercase tracking-[0.08em] text-[#296E50]">Review complete</p>
          <h1 className="mt-2 font-serif text-[length:var(--text-heading-1-size)] font-bold text-[#2B2520]">Every answer is saved and logged</h1>
          <p className="mt-3 text-[length:var(--font-size-base)] text-[#6E5F53]">
            Thank you — your manuscript review is done. Continue to the legal consents to move your book toward release.
          </p>
          <Link
            href="/creator/consents"
            className="mt-5 inline-flex min-h-11 items-center rounded-[10px] bg-[#2B2520] px-6 text-[length:var(--font-size-base)] font-semibold text-[#FAF7F2] no-underline transition-colors hover:bg-[#3d352d]"
          >
            Continue to consents →
          </Link>
        </m.div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1100px] px-5 pb-16 pt-10">
      <p className="mb-1 text-[length:var(--font-size-xs)] font-semibold uppercase tracking-[0.14em] text-[#B3401E]">Creator Portal</p>
      <h1 className="font-serif text-[length:var(--text-heading-1-size)] font-bold leading-[1.15] text-[#2B2520]">Manuscript review</h1>
      <p className="mt-1 mb-4 text-[length:var(--font-size-sm)] text-[#6E5F53]">{bookTitle} — confirm quotes and facts, then sign off.</p>

      {/* Progress */}
      <p className="mb-1 text-[length:var(--font-size-sm)] font-medium text-[#6E5F53]" aria-live="polite">
        {answeredCount} of {items.length} confirmed
      </p>
      <div className="mb-6 h-1.5 w-full overflow-hidden rounded-full bg-[#EADFD1]" aria-hidden>
        <div
          className="h-full rounded-full bg-[#E8622C] transition-all duration-500"
          style={{ width: `${items.length ? (answeredCount / items.length) * 100 : 0}%` }}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[380px_1fr]">
        {/* Question card */}
        <m.section
          initial={{ opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.06 } }}
          className="neu-card self-start rounded-[14px] p-(--space-5)"
          aria-label="Review question"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[length:var(--font-size-2xs)] font-bold uppercase tracking-[0.08em] text-[#B3401E]">{item.code}</span>
            <span className="text-[length:var(--font-size-2xs)] font-semibold text-[#6E5F53]">{KIND_LABEL[item.kind] ?? item.kind}</span>
          </div>
          <h2
            id="review-question-text"
            ref={questionRef}
            tabIndex={-1}
            className="text-[length:var(--font-size-base)] font-medium leading-relaxed text-[#2B2520] rounded-md focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#E8622C]"
          >
            {item.question}
          </h2>

          {hasBlank && (
            <p className="mt-3 rounded-lg bg-[#F3ECDF] p-3 text-[length:var(--font-size-sm)] text-[#6E5F53]">
              Some choices have a blank (<b>____</b>) for a figure. Pick the closest one, then complete it in the <b>Other / the correct fact</b> box below —
              write amounts in full, e.g. &ldquo;about $12,000 a year, covered by dividends&rdquo;.
            </p>
          )}
          {item.options.length === 0 && !isNoAnswerNeeded && (
            <p className="mt-3 rounded-lg bg-[#F3ECDF] p-3 text-[length:var(--font-size-sm)] text-[#6E5F53]">
              This one has <b>no preset choices</b> on purpose — write the actual figure or fact in the box below.
            </p>
          )}
          {isNoAnswerNeeded && (
            <p className="mt-3 rounded-lg bg-[#F3ECDF] p-3 text-[length:var(--font-size-sm)] text-[#6E5F53]">
              <b>No answer is needed</b> — the editor already resolved this. Just type <b>OK</b> below to confirm you understand.
            </p>
          )}

          {item.options.length > 0 && (
            <div className="mt-4 flex flex-col gap-2" role="radiogroup" aria-label={`Options for ${item.code}`}>
              {item.options.map((opt) => (
                <label
                  key={opt.key}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[#EADFD1] bg-[#FFFDF9] p-3 text-[length:var(--font-size-sm)] text-[#2B2520] transition-colors has-[:checked]:border-[#E8622C] has-[:checked]:bg-[#FDF1EA]"
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

          <label htmlFor="freetext" className="mt-4 block text-[length:var(--font-size-sm)] font-semibold text-[#2B2520]">
            Other / the correct fact
          </label>
          <p className="mt-1 text-[length:var(--font-size-xs)] text-[#6E5F53]">
            Use this box for anything the choices don&apos;t cover — especially blanks: write the dollar figure and the reason in full.
          </p>
          <textarea
            id="freetext"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            rows={3}
            className="mt-2 w-full rounded-lg border border-[#EADFD1] bg-[#FFFDF9] p-3 text-[length:var(--font-size-base)] text-[#2B2520] outline-none focus:border-[#E8622C] focus-visible:ring-2 focus-visible:ring-[#B3401E] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FFFDF9]"
            placeholder="Write the correct fact here."
          />

          {error && (
            <p className="mt-3 text-[length:var(--font-size-sm)] font-medium text-[#B3401E]" role="alert">
              {error}
            </p>
          )}
          {justSaved && !error && (
            <p className="mt-3 text-[length:var(--font-size-sm)] text-[#296E50]">
              Saved — you can safely stop here and continue later; your answer is already recorded.
            </p>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => index > 0 && showItem(index - 1)}
              disabled={index === 0}
              className="min-h-11 rounded-[10px] border border-[#EADFD1] px-5 text-[length:var(--font-size-sm)] font-semibold text-[#6E5F53] transition-colors hover:bg-[#F3ECDF] disabled:cursor-not-allowed disabled:opacity-40"
            >
              ← Back
            </button>
            <m.button
              type="button"
              onClick={() => void saveAndNext()}
              disabled={busy}
              whileTap={reduced ? undefined : { scale: 1.015 }}
              className="min-h-11 rounded-[10px] bg-[#2B2520] px-6 text-[length:var(--font-size-sm)] font-semibold text-[#FAF7F2] transition-colors hover:bg-[#3d352d] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save & next"}
            </m.button>
          </div>
        </m.section>

        {/* PDF reader */}
        <m.section
          initial={{ opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE, delay: 0.12 } }}
          className="neu-card flex min-h-[70vh] flex-col rounded-[14px] p-(--space-5)"
          aria-label="Book excerpt"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-[length:var(--font-size-xs)] font-bold uppercase tracking-[0.04em] text-[#6E5F53]">
              The book — review copy
            </span>
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))}
                aria-label="Zoom out"
                className="min-h-8 rounded-md border border-[#EADFD1] px-2.5 text-[#6E5F53] transition-colors hover:bg-[#F3ECDF]"
              >
                −
              </button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="min-h-8 rounded-md border border-[#EADFD1] px-2.5 text-[length:var(--font-size-xs)] font-semibold text-[#6E5F53] transition-colors hover:bg-[#F3ECDF]"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))}
                aria-label="Zoom in"
                className="min-h-8 rounded-md border border-[#EADFD1] px-2.5 text-[#6E5F53] transition-colors hover:bg-[#F3ECDF]"
              >
                +
              </button>
            </span>
          </div>

          <div className="flex flex-1 items-center justify-center overflow-auto rounded-xl bg-[#FFFDF9] p-3">
            {!pdfUrl ? (
              <p className="max-w-[420px] text-center text-[length:var(--font-size-sm)] text-[#6E5F53]">
                No review PDF was attached to your product yet. You can still answer from the questions shown.
              </p>
            ) : viewerError ? (
              <p className="max-w-[420px] text-center text-[length:var(--font-size-sm)] text-[#B3401E]">{viewerError}</p>
            ) : !viewerReady ? (
              <p className="text-[length:var(--font-size-sm)] text-[#6E5F53]">Loading the book…</p>
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
                  {pageText ? `Text of book page ${printed(page)}: ${pageText}` : `Book page ${printed(page)} has no extractable text.`}
                </div>
              </>
            )}
          </div>

          {viewerReady && (
            <div className="mt-3 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="min-h-9 rounded-md border border-[#EADFD1] px-3 text-[length:var(--font-size-sm)] font-semibold text-[#6E5F53] transition-colors hover:bg-[#F3ECDF] disabled:cursor-not-allowed disabled:opacity-40"
              >
                ‹ Prev
              </button>
              <span className="text-[length:var(--font-size-sm)] text-[#6E5F53]">
                book page <b className="text-[#2B2520]">{printed(page)}</b> of <span>{printed(total)}</span>
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(total, p + 1))}
                disabled={page >= total}
                className="min-h-9 rounded-md border border-[#EADFD1] px-3 text-[length:var(--font-size-sm)] font-semibold text-[#6E5F53] transition-colors hover:bg-[#F3ECDF] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next ›
              </button>
            </div>
          )}
        </m.section>
      </div>
    </div>
  );
}
