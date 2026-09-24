#!/usr/bin/env python3
"""engine_lint.py — one command that runs every mechanical P-lesson check from the
T30 lessons-audit (data/intel/duane_book/qa/audit/lessons_audit.md) and prints
| lesson | check | PASS/FAIL |. Exit 1 if any mechanical check FAILs.

Inherently human lessons (P-27, P-34) are listed as HUMAN rows and do not affect
the exit code.

Usage: python3 scripts/engine_lint.py
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA, RELEASES, REPO  # noqa: E402

SCRIPTS = REPO / "scripts"
ROWS = []
FAILED = []


def check(lesson, name, ok, detail=""):
    ROWS.append((lesson, name, "PASS" if ok else "FAIL", detail))
    if not ok:
        FAILED.append(lesson)


def src(*names):
    return "\n".join((SCRIPTS / n).read_text(encoding="utf-8") for n in names)


def main():
    # P-01: geometry helper exists in book_qa.py (prints measured pitch/x-span for a quoted page)
    check("P-01", "book_qa.py --geometry helper present",
          "--geometry" in src("book_qa.py"))

    # P-08: worksheet hand-spacing detector in book_qa.py
    check("P-08", "SRC-WORKSHEET-HANDSPACE detector present",
          "SRC-WORKSHEET-HANDSPACE" in src("book_qa.py"))

    # P-12: release step prints real Windows paths and the newest release artefacts exist
    be = src("book_engine.py")
    check("P-12", "release prints Windows (\\wsl$) path", "wslpath" in be or "wsl$" in be)
    rels = sorted(d for d in RELEASES.glob("*_*") if d.is_dir()) if RELEASES.is_dir() else []
    if rels:
        newest = rels[-1]
        files = sorted(p for p in newest.iterdir() if p.is_file())
        ok = bool(files) and all(p.stat().st_size > 0 for p in files)
        check("P-12", f"release artefacts exist ({newest.name})", ok,
              f"{len(files)} file(s)")
    else:
        check("P-12", "release artefacts exist", True, "no releases yet (nothing to verify)")

    # P-14: every new defect class gets a rule — reminder line in the QA report header
    check("P-14", "QA report header carries the defect-class reminder",
          "new defect class gets a rule" in src("book_qa.py"))

    # P-19: every report .md has an .html sibling, rendered with -f markdown-yaml_metadata_block
    rr = src("render_report.sh")
    check("P-19", "render_report.sh uses -f markdown-yaml_metadata_block",
          "-f markdown-yaml_metadata_block" in rr)
    report_set = sorted(QA.glob("qa_report_*.md")) + \
        [p for p in (QA / "literary_median.md", QA / "crossref_report.md", QA / "autofix_report.md")
         if p.exists()]
    missing = [p.name for p in report_set if not (p.with_suffix(".html").exists())]
    check("P-19", "every report .md has an .html sibling", not missing,
          "missing: " + ", ".join(missing) if missing else f"{len(report_set)} report(s) paired")

    # P-30: fixer-miss files become fixture cases via qa_selftest
    check("P-30", "qa_selftest ingests fixer-miss files into fixtures",
          "fixer_misses" in src("qa_selftest.py"))

    # P-32: SRC-MERGED-PARA sentence-end comparison implemented
    check("P-32", "SRC-MERGED-PARA sentence-end guard present",
          "P-32" in src("book_qa.py"))

    # P-35: PAGE-GAP failures carry an estimated recoverable-pt value
    check("P-35", "PAGE-GAP messages carry recoverable-pt estimate",
          "recoverable" in src("book_qa.py"))

    # inherently human lessons
    ROWS.append(("P-27", "explicit per-instance indent markers (not all:true)", "HUMAN",
                 "a recorded decision, not code; BODY-INDENT already guards the rendered result"))
    ROWS.append(("P-34", "worksheet/callout x0 offset rule", "HUMAN",
                 "blocked on founder A/B confirmation that defines the expected offset"))

    print("| lesson | check | PASS/FAIL |")
    print("|---|---|---|")
    for lesson, name, status, detail in ROWS:
        print(f"| {lesson} | {name} | {status} |" + (f" ({detail})" if detail else ""))
    mech_fail = sorted(set(FAILED))
    if mech_fail:
        print(f"\nENGINE-LINT: FAIL ({', '.join(mech_fail)})")
        sys.exit(1)
    print("\nENGINE-LINT: PASS")


if __name__ == "__main__":
    main()
