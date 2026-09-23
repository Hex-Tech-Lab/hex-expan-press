#!/usr/bin/env python3
"""Combine N re-grade runs for a chapter: median grades, pairwise vote totals, readers, G2.
Usage: regrade_summary.py Ten run1.json run2.json"""
import json, statistics, sys, glob
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from literary_panel import DIMS, JUDGES, PERSONAS, gi, gname  # noqa: E402
ch, files = sys.argv[1], sys.argv[2:]
runs = [json.load(open(f)) for f in files]
base = json.load(open(sorted(glob.glob(str(Path(__file__).resolve().parent.parent / "data/intel/duane_book/qa/literary_runs/2026*.json")))[-1]))["raw"]
patch = Path(__file__).resolve().parent.parent / "data/intel/duane_book/qa/literary_runs/patch_1.json"
if patch.exists():
    base.update({k: v for k, v in json.load(open(patch)).items() if "_error" not in v})
tot, meds, bm = [0, 0, 0], [], []
print("| Dimension | Before | After | new/old/tie |\n|---|---|---|---|")
for d in DIMS:
    b = [x for x in (gi(((base.get(f"judge|{ch}|{j}") or {}).get("dims") or {}).get(d, {}).get("grade")) for j in JUDGES) if x is not None]
    g = [x for x in (gi(((r.get(f"abs|{j}") or {}).get("dims") or {}).get(d, {}).get("grade")) for r in runs for j in JUDGES) if x is not None]
    w = [0, 0, 0]
    for r in runs:
        for j in JUDGES:
            for o in ("old-first", "new-first"):
                v = str(((r.get(f"pair|{j}|{o}") or {}).get("dims") or {}).get(d) or "tie")
                w[0 if v == ("2" if o == "old-first" else "1") else (2 if v == "tie" else 1)] += 1
    tot = [a + c for a, c in zip(tot, w)]
    meds.append(statistics.median(g)); bm.append(statistics.median(b) if b else 0)
    print(f"| {d} | {gname(bm[-1])} | {gname(meds[-1])} | {w[0]}/{w[1]}/{w[2]} |")
print(f"OVERALL {gname(statistics.median(bm))} -> {gname(statistics.median(meds))}; min {gname(min(meds))}; votes new/old/tie {tot}")
for i, r in enumerate(runs, 1):
    print(f"run{i} G2 {[(r.get(f'abs|{j}') or {}).get('G2', {}).get('pass') for j in JUDGES]} errors {[k for k, v in r.items() if '_error' in v]}")
    for p in PERSONAS:
        x = r.get(f"reader|{p}") or {}
        print(f"  {p}: eng {x.get('engagement')} stop={x.get('stop_at')}")
