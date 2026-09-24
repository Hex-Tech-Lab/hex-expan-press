#!/usr/bin/env python3
"""Self-test for the book_qa layout gate (T7b): chapter-range fix and SRC-FENCE-LINE.

Checks:
  1. pdf_chapter_ranges() on the FULL proof vs qa/fixtures/expected_ranges.json
     (PENDING with computed values if the fixture file is absent — another agent owns it).
  2. SRC-FENCE-LINE known-bad fixture (30 manuscript lines + `  ]````) must FAIL;
     known-good copy must PASS.
  3. P-30: every real-chapter fixer miss dropped in qa/fixer_misses/*.md must FAIL
     at least one SRC-side rule and is copied into fixtures/ingested_misses/.

Exit 1 on any FAIL. Usage: .tools/pdfenv/bin/python scripts/qa_selftest.py
"""
import json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA

import book_qa as bq

FIX = QA / "fixtures"
PDF = QA / "fixtures/selftest_book.pdf"
EXPECTED = FIX / "expected_ranges.json"
BAD = FIX / "fence_line_bad.md"
GOOD = FIX / "fence_line_good.md"

results = []


def report(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))


def test_ranges():
    if not PDF.exists():
        report("1 ranges", False, "proof PDF missing")
        return
    computed = bq.pdf_chapter_ranges(bq.pdfplumber.open(PDF))
    if not EXPECTED.exists():
        print(f"PENDING  1 chapter ranges — {EXPECTED.name} absent (another agent owns it)")
        print(f"  computed: {json.dumps(computed)}")
        return
    _exp = json.loads(EXPECTED.read_text()); expected = _exp["chapters"]; exp_back = _exp.get("back_cover", [10**6])
    # starts must match exactly; a gate range may extend over trailing part/blank/photo pages
    # (furniture rules own those), but never past the next chapter's start or into the back cover
    starts = sorted(v[0] for v in expected.values())
    ok = all(computed.get(k, [0])[0] == v[0] and v[1] <= computed[k][1] < min([s for s in starts if s > v[0]] + [min(exp_back)]) for k, v in expected.items())
    report("1 chapter ranges vs expected_ranges.json", ok,
           f"computed={json.dumps(computed)}")


def build_fixtures():
    src = bq.MS.read_text().split("\n")[:30]
    FIX.mkdir(parents=True, exist_ok=True)
    BAD.write_text("\n".join(src + ["  ]```"]) + "\n")
    GOOD.write_text("\n".join(src) + "\n")


def test_fence_line():
    build_fixtures()
    out = {}
    for name, path, want_fail in (("1b bad", BAD, True), ("1b good", GOOD, False)):
        lines = path.read_text().split("\n")
        res = bq.Results()
        bq.check_src(lines, 0, len(lines), res)
        n = res.checked["SRC-FENCE-LINE"]
        f = res.fail["SRC-FENCE-LINE"]
        ok = bool(f) == want_fail
        out[name] = ok
        report(f"1b SRC-FENCE-LINE {name}", ok, f"fails={f[:1]} checks={n}")
    return all(out.values())


def main():
    test_ranges()
    test_fence_line()
    test_miss_fixtures()
    fails = [not r for r in results]
    print(f"\nSELFTEST: {'FAIL' if any(fails) else 'PASS'} ({sum(fails)} failing)")
    sys.exit(1 if any(fails) else 0)


# ---------------------------------------------------------------- P-30: fixer misses -> fixtures
# After a reviewed dry-run, a real-chapter miss is dropped as a .md file under
# qa/fixer_misses/ (manuscript-source misses only). qa_selftest ingests each one
# automatically: the miss must FAIL at least one SRC-side fixable rule, and a
# copy is kept in fixtures/ingested_misses/ as the regression fixture case.
SRC_FIXABLE = {"SRC-HANDBUILT-LIST", "SRC-MANUAL-SPACE", "SRC-ABOVE0",
               "SRC-PAR-OVERRIDE", "SRC-DOUBLE-SPACE", "SRC-HIGHLIGHT",
               "SRC-MERGED-PARA", "SRC-WORKSHEET-HANDSPACE"}
MISSES = QA / "fixer_misses"


def test_miss_fixtures():
    if not MISSES.is_dir():
        report("2 fixer-miss fixtures", True, "no qa/fixer_misses/ dir (no misses to ingest)")
        return
    files = sorted(MISSES.glob("*.md"))
    if not files:
        report("2 fixer-miss fixtures", True, "qa/fixer_misses/ empty (no misses to ingest)")
        return
    out_dir = FIX / "ingested_misses"
    out_dir.mkdir(parents=True, exist_ok=True)
    ok_all = True
    for f in files:
        lines = f.read_text(encoding="utf-8").split("\n")
        res = bq.Results()
        bq.check_src(lines, 0, len(lines), res)
        fails = sorted(rid for rid in SRC_FIXABLE if res.fail[rid])
        ok = bool(fails)
        ok_all &= ok
        report(f"2 fixer-miss {f.name}", ok,
               f"fails={fails if fails else 'none — not a SRC-side miss; move it out or note it'}")
        if ok:
            (out_dir / f.name).write_text(f.read_text(encoding="utf-8"), encoding="utf-8")


if __name__ == "__main__":
    main()
