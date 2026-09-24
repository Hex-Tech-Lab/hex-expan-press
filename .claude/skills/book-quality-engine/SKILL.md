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

## Phase M: Manuscript

**Loop.** Remediation (every dimension ≥ B), then Optimization (toward book ≥ A-). Priority: reader drop-off first, then worst grade [M-12].

1. **Baseline.** `python3 scripts/literary_metrics.py`, then the full panel `python3 scripts/literary_panel.py` (20–30 min). Run it in the background with a done-file [X-01]. The newest `qa/literary_runs/*.json` becomes the "before" reference.
2. **Per chapter:**
   1. `python3 scripts/chapter_brief.py <Ch> [--patch …]` builds the brief: all layers plus the book graph.
   2. Back up the manuscript to `qa/revisions/manuscript_before_ch<N>_v<k>.md` [M-14].
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
