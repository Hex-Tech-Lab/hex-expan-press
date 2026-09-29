# 0056 — Tactile Neo-Minimalism Design System

**Status:** Accepted
**Date:** 2026-09-28
**Supersedes:** the legacy static site's inline Tailwind config styling (`web/index.html` pre-port) as the source of visual truth
**Superseded-by:** —

## Context

The public site's visual language was first materialized as `web/index.html` built "in Tactile Neo-Minimalism aesthetic" (commit f2af539, 2026-09-27). The Wave 2/3 App Router migration (ADR-0053) then required that language to live in code the Next build can own, not in a static HTML file. The founder's motion contract (2026-09-28, recorded in `web/src/components/landing/landing-page.tsx` header comment) is the forcing function: "the page must be ALIVE — built by motion, not decorated with it."

## Decision

1. **The palette is three tokens and nothing else.** `web/src/design/tokens.ts` holds `canvas: #F9F6F0` (warm paper), `charcoal: #181818` (ink), `peach: #FF9E80` (accent) — "the EXACT existing colors from the legacy static site... Do not invent colors here; design decisions route through the founder." The same three are mirrored as Tailwind v4 `@theme` variables in `web/app/globals.css` (`--color-canvas`, `--color-charcoal`, `--color-peach`), so `bg-canvas text-charcoal` class usage in `web/app/layout.tsx` stays type-safe.
2. **Typography carries the "tactile" voice.** `body { font-feature-settings: "cv02", "cv03", "cv04", "cv11" }` is applied globally (commit e59f05e, carried from the f2af539 landing); the body element uses `font-sans antialiased`.
3. **Glass surfaces carry ONLY background + blur; bevels are per-surface.** `.glass-card` is `rgba(255,255,255,0.78)` + `backdrop-filter: blur(28px)`. The NEMA-style 3D bevels are separate classes: `.card-shadow` (light-cream inset top light + bottom inner shading), `.dock-shadow` (white bevel on the vertical dock), and a darker tone for the bottom bar/spotlight — "light falls from above, so surfaces turned away from it get darker edges" (commit 112ad4a, Wave 3.4 founder-feedback pass).
4. **Motion is a construction system, not decoration.** The Wave 3 motion rebuild (commits 690bc2c, 6d4e3fc, b5cf9f0, 112ad4a) fixed the contract in `landing-page.tsx`: entrance assembles the layout with a beat; idle elements keep moving (breathing voice orb, rotating income ring, traveling journey pulse); bento cards are pointer-3D with shading — tilt capped at 2.5deg with 1200px parent perspective; click orchestration expands a card via layout animation into a charcoal detail slide and reverses on close; swift-out Apple easing `[0.32,0.72,0,1]` at 0.5s for layout transitions; heavy damped physics (spring 100/25/1, settle bezier `[0.16,1,0.3,1]` at 0.6s, no bouncing).
5. **Reduced motion is a hard contract.** CSS kills non-essential transitions/animations globally under `prefers-reduced-motion: reduce`; Framer Motion is separately gated via `useReducedMotion`, and every variant builder takes a `reduced` flag (`bentoVariants(reduced)`, `bentoItemVariants(reduced)`). Coarse pointers yield as well.
6. **Astryx tokens are the portal's neutral substrate.** The creator portal extracts its neutral tokens to `web/app/creator/astryx-tokens.css` (hoisted to `web/app/creator/` in commit d9f1df7), backed by the `@astryxdesign/core` 0.1.8 and `@astryxdesign/theme-neutral` 0.1.8 packages in `web/package.json` (added commit a5d29f6).
7. **Shared components are extracted, not duplicated.** The Journey dots indicator lives once in `web/src/components/journey/journey-dots.tsx` (duplication pass, commit a5d29f6).

## Consequences / Tradeoffs

- **Easier:** every surface (landing, portal, error states) draws from the same three-token palette and glass/bevel classes; a founder-directed palette change is a two-file edit (`tokens.ts` + `globals.css`).
- **Harder:** no fourth color may be introduced without the founder; shadings must derive from the existing three via opacity/inset composition (the bevel ladder does exactly this).
- **Accepted cost:** motion complexity is high by contract — the landing page's orchestration (layout animations, pointer-3D shading, per-card stages) is deliberately heavier than a static render, and every addition must respect the reduced-motion gates or it is rejected.
- **Standing rule:** `web/src/design/tokens.ts` is the palette SSOT; the `@theme` block in `globals.css` must mirror it exactly.

## Sources

- `git log --since=2026-09-25` commits f2af539, e59f05e, 690bc2c, 6d4e3fc, b5cf9f0, 112ad4a, a5d29f6, d9f1df7
- `web/src/design/tokens.ts` (palette SSOT header comment)
- `web/app/globals.css` (@theme block, glass/bevel class comments, reduced-motion contract)
- `web/src/components/landing/landing-page.tsx` (founder motion contract header, variant builders)
- `web/package.json` (@astryxdesign/core 0.1.8, @astryxdesign/theme-neutral 0.1.8, framer-motion 12.40.0)
