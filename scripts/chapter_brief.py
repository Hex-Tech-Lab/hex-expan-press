#!/usr/bin/env python3
"""Compiled remediation brief for one chapter (founder's method, 2026-09-23).
Pulls every layer for the chapter into one view: per-judge grades and the gap to the book median,
chapter verdict reasons, reader notes (all three personas), judge disagreements, revision notes,
Layer-A signals, and contradictions (tagged for the creator, not for the rewrite).
Usage: chapter_brief.py Five [--run <run.json>] [--patch <patch.json>]
Writes data/intel/duane_book/qa/chapter_briefs/ch<N>_brief.md + .html
"""
import json, statistics, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from literary_panel import DIMS, JUDGES, PERSONAS, FACT_CHECKERS, gi, gname  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
QA = REPO / "data/intel/duane_book/qa"
NUM = "One Two Three Four Five Six Seven Eight Nine Ten".split()


def main():
    ch = sys.argv[1]
    run_path = Path(sys.argv[sys.argv.index("--run") + 1]) if "--run" in sys.argv else sorted((QA / "literary_runs").glob("2026*.json"))[-1]
    raw = json.loads(run_path.read_text())["raw"]
    if "--patch" in sys.argv:
        for k, v in json.loads(Path(sys.argv[sys.argv.index("--patch") + 1]).read_text()).items():
            if "_error" not in v:
                raw[k] = v
    metrics = json.loads((QA / "literary_metrics.json").read_text())
    J = lambda n, j: raw.get(f"judge|{n}|{j}", {})  # noqa: E731
    med = {n: {d: statistics.median([g for g in (gi(((J(n, j).get("dims") or {}).get(d) or {}).get("grade")) for j in JUDGES) if g is not None] or [0]) for d in DIMS} for n in NUM}
    book_med = {d: statistics.median(med[n][d] for n in NUM) for d in DIMS}
    ch_overall = statistics.median(med[ch].values())
    book_overall = statistics.median(statistics.median(med[n].values()) for n in NUM)
    L = [f"# Remediation brief — Chapter {ch}", "",
         f"Chapter overall **{gname(ch_overall)}** vs book median **{gname(book_overall)}** (gap {ch_overall - book_overall:+.1f} steps). "
         f"Source run: `{run_path.name}`.", "",
         "## 1. Dimensions — per judge, median, gap to book median", "",
         "| Dimension | " + " | ".join(j.split(":")[1].split("/")[-1] for j in JUDGES) + " | Median | Book median | Gap | Phase |",
         "|---|" + "---|" * (len(JUDGES) + 4)]
    for d in DIMS:
        gs = [((J(ch, j).get("dims") or {}).get(d) or {}).get("grade") or "—" for j in JUDGES]
        m, b = med[ch][d], book_med[d]
        phase = "**REMEDIATE**" if m < gi("B-") else ("optimize" if m < gi("A-") else "keep")
        L.append(f"| {d} | " + " | ".join(gs) + f" | **{gname(m)}** | {gname(b)} | {m - b:+.1f} | {phase} |")
    L += ["", "## 2. Why the chapter fails (thresholds: median ≥ B+, no dimension < B-, G2 pass)", ""]
    low = [d for d in DIMS if med[ch][d] < gi("B-")]
    L.append(f"- Dimensions below B-: {', '.join(low) if low else 'none'}")
    g2 = [(j, J(ch, j).get("G2") or {}) for j in JUDGES]
    L.append(f"- G2 credibility: {sum(1 for _, g in g2 if g.get('pass'))}/{len(JUDGES)} judges pass")
    for j, g in g2:
        for i in (g.get("issues") or [])[:3]:
            L.append(f"  - ({j.split(':')[1].split('/')[-1]}) {i}")
    L += ["", "## 3. Evidence the judges quoted for the weak dimensions", ""]
    for d in low or DIMS[:3]:
        for j in JUDGES:
            e = (J(ch, j).get("dims") or {}).get(d) or {}
            if e:
                L.append(f"- **{d}** ({j.split(':')[1].split('/')[-1]}, {e.get('grade')}): “{e.get('quote','')}” — {e.get('why','')}")
    L += ["", "## 4. Reader panel on this chapter", "", "| Reader | Engagement | Would stop at | Felt repetitive | Would do tomorrow |", "|---|---|---|---|---|"]
    for p in PERSONAS:
        r = ((raw.get(f"reader|{p}") or {}).get("chapters") or {}).get(ch) or {}
        L.append(f"| {p} | {r.get('engagement','—')} | {r.get('stop_at') or '—'} | {r.get('repetitive') or '—'} | {r.get('do_tomorrow') or '—'} |")
    L += ["", "## 5. Judge disagreements (> 1 grade step)", ""]
    for d in DIMS:
        gs = [gi(((J(ch, j).get("dims") or {}).get(d) or {}).get("grade")) for j in JUDGES]
        gs = [g for g in gs if g is not None]
        if gs and max(gs) - min(gs) > 3:
            L.append(f"- {d}: " + ", ".join(f"{j.split(':')[1].split('/')[-1]} {((J(ch, j).get('dims') or {}).get(d) or {}).get('grade')}" for j in JUDGES))
    L += ["", "## 6. Revision notes from the judges", ""] + [f"- ({j.split(':')[1].split('/')[-1]}) {e}" for j in JUDGES for e in (J(ch, j).get("top_edits") or [])]
    m = metrics["chapters"].get(ch, {})
    bm = metrics["book"]
    L += ["", "## 7. Measured signals (Layer A) vs book", "",
          "| Signal | Chapter | Book |", "|---|---|---|"] + [f"| {k} | {m.get(k)} | {bm.get(k)} |" for k in ("words", "sent_len_mean", "burstiness", "predictability", "fk_grade", "mattr", "quotes_per_1k", "numbers_per_1k", "sources_per_1k")]
    if m.get("repeated_4grams"):
        L.append(f"\nRepeated phrases: {', '.join(m['repeated_4grams'])}")
    L += ["", "## 8. Contradictions touching this chapter — FOR THE CREATOR (do not change in the rewrite)", ""]
    for fc in FACT_CHECKERS:
        for c in (raw.get(f"facts|{fc}") or {}).get("contradictions") or []:
            chs = [str(c.get(x, {}).get("chapter", "")) for x in ("a", "b")]
            if any(ch in s for s in chs):
                L.append(f"- [{c.get('severity')}] {c.get('fact')} ({fc.split(':')[1].split('/')[-1]})")
    out = QA / "chapter_briefs"
    out.mkdir(exist_ok=True)
    md = out / f"ch{NUM.index(ch) + 1}_brief.md"
    md.write_text("\n".join(L))
    subprocess.run([str(REPO / ".tools/pandoc/bin/pandoc"), "-f", "markdown-yaml_metadata_block", str(md), "-s", "--metadata",
                    f"title=Remediation brief — Chapter {ch}", "--embed-resources", "--css", str(QA / "report.css"), "-o", str(md.with_suffix(".html"))], check=False)
    print("\n".join(L))


if __name__ == "__main__":
    main()
