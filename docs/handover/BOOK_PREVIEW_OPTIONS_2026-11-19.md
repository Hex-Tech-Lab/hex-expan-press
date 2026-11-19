# Book Previewer Library Options Comparison

**Date:** 2026-11-19  
**Context:** ExpanPress product page (`/books/[handle]/[product]`) interactive page-turning previewer for public preview PDFs (React `19.2.7`, Next.js `16.4.5`, existing `pdfjs-dist@4.10.38` with local worker `/pdfjs/pdf.worker.min.mjs`).

## Candidate Comparison

| Criterion | Option 1: `pdfjs-dist` + `page-flip` (`StPageFlip` v2.0.7) | Option 2: `react-pdf` (v11.1.0, `wojtekmaj/react-pdf`) | Option 3: `@react-pdf-viewer/core` (v3.12.0) |
|---|---|---|---|
| **Licence** | `pdfjs-dist`: Apache-2.0; `page-flip`: **MIT** (zero commercial restrictions). | `react-pdf`: **MIT**; `pdfjs-dist`: Apache-2.0. | **Proprietary commercial licence** (`react-pdf-viewer.dev/license`; paid commercial licence required for production SaaS). |
| **Bundle size** | `page-flip` adds **~43 KB minified / ~10.2 KB min+gzip** with **0 dependencies**. `pdfjs-dist@4.10.38` is already installed and lazy-loaded via local `/pdfjs/pdf.worker.min.mjs`. | `react-pdf` is **~339 KB unpacked** plus 9 dependencies (`es-toolkit`, `clsx`, `dequal`, etc.) and pulls `pdfjs-dist@6.5.438` (version mismatch with existing `4.10.38`). | Core package is **~345 KB unpacked** plus separate plugin packages (`@react-pdf-viewer/default-layout`, etc.) and `pdfjs-dist` v2/v3. |
| **Maintenance & Stack Fit** | `pdfjs-dist` actively maintained by Mozilla. `page-flip@2.0.7` (May 2022) is vanilla TypeScript/JS with **0 React coupling**, works cleanly in React 19 via `useRef`/`useEffect`, and is already the repo's chosen library in `scripts/flipbook_build.py`. *(Note: `react-pageflip@2.0.3` breaks on React 19 because `ReactDOM.findDOMNode` was removed.)* | Actively maintained (`v11.1.0`, Nov 2026, React 19 peer dependency). However, it renders flat pages only — it has **no page-turning or book-spread physics**. Pairing it with `react-pageflip` hits the React 19 `findDOMNode` failure. | Stale (`v3.12.0`, Mar 2023). Peer dependencies require `pdfjs-dist@^2.16.105 || ^3.0.279` and React 16–18 era patterns; incompatible with `pdfjs-dist@4.10.38`. |
| **Accessibility** | `StPageFlip` canvas lacks built-in ARIA; our thin React wrapper adds official `flipPrev()`/`flipNext()` buttons (44px+ hit targets), scoped `ArrowLeft`/`ArrowRight`/`Home`/`End` keyboard listeners, `aria-live="polite"` spread announcements, and an accessible text disclosure from `pdfPage.getTextContent()`. | Built-in `TextLayer` & `AnnotationLayer` DOM overlays provide strong text selection and screen-reader semantics for flat reading, but no page-spread semantics out of the box. | Full toolbar ARIA and keyboard shortcuts for flat document viewing, but no book-flip semantics. |
| **Mobile** | Native touch swipe & corner drag (`swipeDistance`, `mobileScrollSupport`), `size: "stretch"`, and automatic `usePortrait` switching: **2-page landscape spread on desktop** and **1-page portrait fit on mobile** (`showCover: true`). | Responsive width via `width` prop / `ResizeObserver`, but vertical scroll or single-button paging only — no swipe-to-turn-page book feel. | Pinch/zoom and scroll toolbar UX aimed at desktop document inspection, not mobile book browsing. |

## Recommendation

**Choose Option 1: `pdfjs-dist` (`4.10.38`, already installed) + `page-flip` (`StPageFlip` v2.0.7).**

- **Why yes:**
  - **Minimal incremental bundle & zero dependency conflict:** Reuses the exact `pdfjs-dist@4.10.38` + local `/pdfjs/pdf.worker.min.mjs` worker already verified in the creator review viewer (`web/app/creator/review/review-client.tsx`), adding only ~10.2 KB gzipped (`page-flip`) with zero transitive dependencies.
  - **React 19 & Next.js 16 compatible:** Imperative mounting on a child stage node inside `useEffect` (with `pf.destroy()` cleanup) avoids `react-pageflip`'s broken `ReactDOM.findDOMNode` dependency and survives React 19 `StrictMode` double-mount cleanly.
  - **Repo alignment & realistic UX:** Matches `scripts/flipbook_build.py` (`StPageFlip`), renders true 2-page book spreads on desktop (`showCover: true`) and single-page swipeable portrait mode on mobile, while our React wrapper supplies WCAG 2.1/2.2 AA controls, keyboard navigation, and PDF.js text-layer accessibility.
  - **Permissive OSS licence:** Apache-2.0 + MIT with zero commercial licensing cost.
- **Why no (trade-offs & alternatives rejected):**
  - **Trade-off of Option 1:** `StPageFlip` draws onto `<canvas>` in image mode, so accessibility is not automatic — it requires the wrapper's explicit `aria-live` spread status, keyboard handlers, and `getTextContent()` accessible text region, and `destroy()` removes its root element (handled by mounting on an imperative child `stage` element).
  - **Why not Option 2 (`react-pdf`):** Does not provide page-turning/flipbook physics on its own, pulls a conflicting `pdfjs-dist@6.x` dependency, and cannot be paired with `react-pageflip` on React 19.
  - **Why not Option 3 (`@react-pdf-viewer/core`):** Requires a paid commercial licence, is unmaintained since 2023, pins incompatible `pdfjs-dist` v2/v3, and lacks page-turning spread UX.
