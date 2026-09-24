#!/usr/bin/env python3
"""panel_median.py — grade on the median of the last N literary panel runs (T34).

Loads the newest N run files in <QA>/literary_runs/*.json (patch/rerun helpers and the
_invalid/ subfolder excluded by the 2026*.json glob), converts letter grades to the
literary_panel.py scale index, and reports per chapter: median overall, median per
dimension, spread (max-min in steps), and the verdict with literary_panel.py's rules
(chapter PASS = median overall >= B+, no dimension median < B-, G2 pass in >= 2 of the
N runs — G2 per run derived from raw judges' "G2" {"pass": bool} with >= 2 of 3 judges).
Book overall = median of chapter medians.

Writes <QA>/literary_median.json and <QA>/literary_median.md.

CLI: python3 scripts/panel_median.py [--n 3]
"""
import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA, CHAPTERS  # noqa: E402

SCALE = ["F", "D", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"]
DIMS = ["Promise delivery", "Actionability", "Information value", "Originality", "Structure & arc",
        "Hook & ending", "Voice & prose", "Clarity & cohesion", "Pacing & density",
        "Stakes & momentum", "Human texture & example range", "Audience fit (55+)"]


def gi(g):
    g = (g or "").strip().upper().replace("−", "-")
    return SCALE.index(g) if g in SCALE else None


def gname(i):
    return SCALE[max(0, min(len(SCALE) - 1, round(i)))] if i is not None else None


def load_runs(n):
    """Newest N valid run dicts (files starting '2026', .json, not in _invalid/)."""
    files = sorted(QA.glob("literary_runs/2026*.json"))[-n:]
    out = []
    for f in files:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(d.get("table"), dict):
                out.append(d)
        except Exception as e:  # noqa: BLE001
            print(f"warning: skipping unreadable run {f.name}: {e}", file=sys.stderr)
    return out


def run_g2(run, ch):
    """True if >= 2 of this run's judges returned G2 pass for chapter ch."""
    passes = [bool(((v or {}).get("G2") or {}).get("pass"))
              for k, v in (run.get("raw") or {}).items()
              if isinstance(v, dict) and k.startswith(f"judge|{ch}|")]
    return passes.count(True) >= 2


def compute(n=3, qa_dir=QA):
    """Median-of-runs result. Returns None if no valid runs exist.

    Per chapter (book order): overall_median (index), overall_letter, dim_medians
    ({dim: letter}), spread (max-min steps across runs' chapter_overall), verdict
    PASS/FAIL (literary_panel rules on the medians + G2 pass in >= 2 of the N runs),
    g2_runs (how many runs passed G2). Book overall = median of chapter medians.
    """
    runs = load_runs(n)
    if not runs:
        return None
    order = [c for c in CHAPTERS] + sorted(
        {c for r in runs for c in (r.get("chapter_overall") or {})} - set(CHAPTERS))
    chapters = {}
    for ch in order:
        overalls = [gi((r.get("chapter_overall") or {}).get(ch)) for r in runs]
        overalls = [v for v in overalls if v is not None]
        dims = {}
        for d in DIMS:
            gs = [gi((r.get("table") or {}).get(ch, {}).get(d)) for r in runs]
            gs = [v for v in gs if v is not None]
            if gs:
                dims[d] = gname(statistics.median(gs))
        g2_runs = sum(1 for r in runs if run_g2(r, ch))
        if not overalls:
            chapters[ch] = {"overall_letter": None, "dim_medians": dims, "spread": None,
                            "verdict": "INCOMPLETE", "g2_runs": g2_runs, "runs_with_grade": 0}
            continue
        med = statistics.median(overalls)
        dims_vals = [gi(v) for v in dims.values()]
        ok = med >= gi("B+") and (not dims_vals or min(dims_vals) >= gi("B-")) and g2_runs >= 2
        chapters[ch] = {"overall_median": round(med, 2), "overall_letter": gname(med),
                        "dim_medians": dims, "spread": max(overalls) - min(overalls),
                        "verdict": "PASS" if ok else "FAIL", "g2_runs": g2_runs,
                        "runs_with_grade": len(overalls)}
    medians = [c["overall_median"] for c in chapters.values() if c.get("overall_median") is not None]
    book = statistics.median(medians) if medians else None
    return {"n_requested": n, "runs_used": len(runs),
            "run_files": [f.name for f in sorted(QA.glob("literary_runs/2026*.json"))[-n:]],
            "book_overall": gname(book), "book_overall_median": round(book, 2) if book is not None else None,
            "chapters": chapters}


def render_md(res):
    runs_used, req = res["runs_used"], res["n_requested"]
    head = (f"# Literary gate — median of last {req} panel runs\n\n"
            f"**{runs_used} of {req} runs** used: {', '.join(f'`{f}`' for f in res['run_files'])}\n\n"
            if runs_used < req else
            f"# Literary gate — median of last {req} panel runs\n\n"
            f"Runs used: {', '.join(f'`{f}`' for f in res['run_files'])}\n\n")
    names = list(res["chapters"])
    dims = sorted({d for c in res["chapters"].values() for d in c["dim_medians"]})
    out = [head, "| Chapter | Median overall | Spread (steps) | " + " | ".join(dims) + " | Verdict | G2 runs pass |",
           "|---|---|---|" + "---|" * len(dims) + "---|---|"]
    for ch in names:
        c = res["chapters"][ch]
        row = ([ch, c["overall_letter"] or "—",
                str(c["spread"]) if c["spread"] is not None else "—"]
               + [c["dim_medians"].get(d, "—") for d in dims]
               + [c["verdict"], f"{c['g2_runs']}/{runs_used}"])
        out.append("| " + " | ".join(str(x) for x in row) + " |")
    out += ["", f"**Book overall: {res['book_overall']}** (median of chapter medians)", "",
            "Verdict rules (same as literary_panel.py): chapter PASS = median overall >= B+, "
            "no dimension median < B-, G2 pass in >= 2 of the runs used."]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(prog="panel_median.py")
    ap.add_argument("--n", type=int, default=3)
    args = ap.parse_args()
    res = compute(args.n)
    if res is None:
        print("no valid literary runs found", file=sys.stderr)
        return 1
    md = render_md(res)
    (QA / "literary_median.json").write_text(json.dumps(res, indent=1, ensure_ascii=False))
    (QA / "literary_median.md").write_text(md)
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
