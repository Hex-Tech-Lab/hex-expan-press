---
name: book-quality-engine
description: Two-phase layered QA engine for producing a publish-ready book. Phase M (manuscript) grades and improves content through metrics, a multi-model judge panel, accuracy gates, a reader panel, a book graph and creator review. Phase P (packaging) turns it into a PDF governed by design tokens, a rules-as-code layout gate, a PDF post-process and visual regression. Use when remediating or optimizing chapters, running the literary panel, doing a chapter layout pass, fixing typesetting defects, or cutting a book release.
---

# Book Quality Engine

Two phases, each a stack of layers. A layer runs only when the layers under it pass. Work **one chapter at a time**. The authoritative design is ADR 0047, and the lessons behind every rule are in `data/intel/duane_book/qa/lessons_learned.md` (ids in brackets below). **Append new lessons to that register as you find them.**

```
Phase M  Manuscript   M0 Sources → M1 Metrics → M2 Judge panel → M3 Accuracy → M4 Readers → M5 Book graph → M6 Creator
Phase P  Packaging    P1 Tokens/rules → P2 Components → P3 Build → P4 Post-process → P5 Layout gate → P6 Visual regress → P7 Human sign-off → P8 Release
Order: M stable for a chapter → then P for that chapter.
```

## Entry point and helpers
- `python3 scripts/book_engine.py status | m-baseline | m-chapter <Ch> <before> | p-chapter <Ch> [Next] | release <label>` enforces the layer order (P refuses while M fails; release refuses unless everything passes; `--force` overrides, `--dry-run` shows the commands).
- `.tools/pdfenv/bin/python scripts/qa_selftest.py`: run before trusting any layout report [P-24].
- `scripts/layout_autofix.py --dry-run|--apply` applies the MECHANICAL items of `qa/autofix_triage.json`. Audit the dry-run, then rebuild + gate + leak grep [P-21].
- `scripts/review_build.sh` builds the creator review copy with yellow marks from `qa/review_marks.json` (temp copy only).
- `scripts/premise_router.py` → `qa/creator_queue_proposals.md` (premise signals + NEW contradictions; proposals only).
- `scripts/quality_dashboard.py` → `qa/dashboard.html`.
- Rubric = `qa/rubric/{core.json,modules/*.json,profiles/<book>.json}`, loaded by `scripts/rubric_loader.py`.

## New book (any book, not just Duane)
1. Create `books/<id>.json` (id, title, author, book_dir, manuscript, template, data_dir, fonts, panel_brief, backcover_marker, rubric_profile, release_prefix). Put the book dir under `data/` (gitignored) with symlinks to the house `template.typ`, `design_rules.json` and `img_v3`.
2. `export BOOK=<id>`. Every script reads paths, chapters (from `#chaphead`), parts (from `#partpage`) and build flags from `scripts/book_config.py`. Never hard-code a path, a chapter list or a book description.
3. Smoke-test: `BOOK=smoke` (2 chapters, `data/intel/smoke_book`) must build → gate PASS after `p-fix` before any engine change ships.
4. Still book-specific in the template: the front cover (design D). Move it to book metadata before book 2.

## Build (one set of flags for every tool)
- `book_config.PANDOC_FLAGS`: `--shift-heading-level-by=-1` (### → level 2, PDF/UA heading order) and the `rawblock_parbreak.lua` filter (a paragraph right after a Typst block otherwise merges into it). `TYPST_FLAGS`: `--pdf-standard ua-1` (tagged, alt text required on every image). Any tool that compiles the book must use these flags, or its layout measurements are wrong.
- After the compile: `pdf_viewer_prefs.py` (true spreads, cover alone) and `pdf_tracking_to_tc.py` (it verifies itself: "tracking verify: OK").
- Chapter slices come only from `book_config.chapter_sources()`: they end at the next chapter, the next part page or the back cover.

## Jev (typed decisions, `scripts/jev.py`)
Bands: ≥0.8 act · 0.5–0.8 act and FLAG · <0.5 or unavailable → current behaviour, UNCHECKED. Send only minimal spans. Every call site has `--no-jev` and a fallback.
- LIVE: `trim_check.py` (meaning_kept/drops_fact), `crossref_check.py` (banded), `chapter_regrade.py` (no-new-facts guard per changed paragraph; pairwise old/new), `literary_panel.py` (G2 unsourced-claim pre-check), `premise_router.py` (contradiction triage, reader-stop themes), `layout_fixers.py` (changes_meaning on prose hunks), `agent_audit.py` / `agent_watch.sh` (agent REPORT evidence, stalls).
- Wording trims: `trim_check.py` → `trim_apply.py [--fillback --page N --marker …]` (puts text back while the box still fits). Every trim ends in a before/after table.

## Accessibility (enforced)
PDF/UA-1 build = blocker. Alt text on every `chaphead(img:, alt:)` and `#image(alt:)`. Contrast ≥ 4.5:1 for small text (quiet grey `#736351`), text ≥ 7.5pt. Before release: veraPDF + PAC 2024.

## Agents
- OC: `opencode run --model openrouter/z-ai/glm-5.3-flash --variant minimal`, at most 3 at once, staggered 25–30s ("database is locked" otherwise), no /tmp, /dev or `<(...)` in the prompts. They work on private copies and propose; the orchestrator applies. Run `agent_audit.py <log>` on every REPORT and repeat its acceptance command yourself (T28/T29 died mid-edit and still looked done).

## Phase M: Manuscript

**Loop.** Remediation (every dimension ≥ B), then Optimization (toward book ≥ A-). Priority: reader drop-off first, then worst grade [M-12].

1. **Baseline.** `python3 scripts/literary_metrics.py`, then the full panel `python3 scripts/literary_panel.py` (20–30 min). Run it in the background with a done-file [X-01]. The newest `qa/literary_runs/*.json` becomes the "before" reference.
2. **Per chapter:**
   1. `python3 scripts/chapter_brief.py <Ch> [--patch …]` builds the brief: all layers plus the book graph.
   2. Back up: `python3 scripts/backup.py <file> <tag>` (automatic in `chapter_regrade.py`) [M-14].
   3. Edit `manuscript/book/manuscript.md`.
   4. `scripts/regrade2.sh <Ch> <backup>` runs 2 re-grade runs, then `regrade_summary.py` gives the median grades and the side-by-side votes.
   5. **Accept** if the side-by-side favours the new version and no dimension regresses [M-03]. At most 2 passes, then escalate [M-16].
3. **Rewrite rules.**
   - No new facts. Human texture only from transcripts and fact cards [M-08].
   - Contradictions are left verbatim and go to the creator queue [M-09].
   - A duplicate story points to the chapter that owns it (`book_graph.json`) [M-11].
   - Hedge advice as opinion.
   - No layout code in content [P-05].
4. **Drop-off that survives rewording is a premise problem.** Escalate it to the creator; don't blur honesty to fix it [M-10].
5. **Judges.**
   - Use the cheap roster only, with exact model names, and verify which model actually ran [M-05].
   - OpenRouter: low reasoning, pinned provider, on `finish_reason: length` double the budget and retry, never fail silently [M-04].
   - Metrics are signals, not grades [M-01]. Every grade quotes evidence; use the median [M-02].
   - Chapter boundaries come from explicit markers [M-06].
6. **Reports.** Rebuild from the stored run (`--from-run --patch`) [M-07]. Always produce .md + .html, and give both paths [X-06].

## Phase P: Packaging

1. **Tokens are the single source.** `design_rules.json`: the template reads its tokens, and the gate derives its targets from them [P-07]. Pitches use at most 2 decimals [P-03].
2. **Typst semantics to remember.**
   - `par.spacing` *replaces* leading: spacing = leading + P [P-02].
   - A top-level `#set` in a fence leaks into the rest of the book [P-04].
   - Hard-coded page numbers go stale, so suppress headers/footers with semantic markers + a query [P-10].
3. **Components own their spacing** (worksheet `note:`, box header geometry held constant, table in one unbreakable block with its heading) [P-06, P-08, P-09]. Indents follow Chicago [P-15]. The opener uses `chaphead(img:)` [P-16].
4. **Chapter proof:** `QA_CHAPTERS=<Ch> scripts/chapter_proof.sh <Ch> <NextCh>` runs build → Tc pass [P-11] → `book_qa.py` → `visual_regress.py`. Report: `qa/qa_report_<Ch>.md`.
5. **Fix by class:** grep every instance, add a rule to `design_rules.json` before or with the fix, and re-run the gate [P-14, X-05]. Test a new rule on a known-good and a known-bad chapter [P-13].
6. **Human sign-off.** The founder's Acrobat readings are the spec. Convert them (line spacing = pitch ÷ size; paragraph spacing = extra above the pitch), and measure with `pdftotext -bbox` before disputing one [P-01]. Hand over real files by their Windows path [P-12]. Approve visual baselines only after sign-off [P-17].
7. **Release:** versioned release dir, samplers via `sampler_build.sh`, and `current.pdf` as a real file.

## Operating rules
- Wait on done-files; never pgrep/pkill a pattern that appears in your own command [X-01].
- OC background runs use `< /dev/null` and in-repo paths only [X-02].
- Verify pasted directives and handover numbers against the repo [X-03, X-04].
- One ledger line per action (`docs/agent_ledger.jsonl`).
- Never commit `data/`, `adr/` or `manuscript/book/`; commit only when asked [X-08].

## Book profile (book-specific; keep out of the generic skill)
Duane book: `data/intel/duane_book/{qa,facts,releases}`, transcripts `data/db/samples/duane_retirearly500/transcripts/`, thresholds book ≥ A-, no chapter < B, Comfort Print baseline (ADR 0039/0043).
